import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PAccountsDomain } from './p2pAccounts'

const user = { userId: 'user-a', username: 'alice' }
const network = { userId: user.userId, networkId: 'net-a', name: 'Office', maxDevices: 10 }
function setup(overrides: Partial<P2PManagementApi> = {}) {
  const api = {
    currentUser: vi.fn(async () => ({ ok: true as const, data: user })),
    networks: vi.fn(async () => ({ ok: true as const, data: [network] })),
    ...overrides
  } as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  return { api, management, accounts: new P2PAccountsDomain(management) }
}

describe('P2P user and network domain', () => {
  it('requires explicit selection and preserves network IDs instead of matching names', async () => {
    const { accounts } = setup()
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
    accounts.select('service-a', 'Office')
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
    accounts.select('service-a', 'net-a')
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-a')
    expect(accounts.state('service-b').networks).toBeUndefined()
  })

  it('registers an account and adopts the returned user like a login', async () => {
    const register = vi.fn<P2PManagementApi['register']>().mockResolvedValue({
      ok: true,
      data: user
    })
    const { accounts } = setup({ register })
    await accounts.register('service-a', 'alice@example.com', 'new-secret')
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        email: 'alice@example.com',
        password: 'new-secret'
      })
    )
    expect(accounts.state('service-a').user).toEqual(user)
    expect(accounts.state('service-a').networks).toBeUndefined()
  })

  it('keeps a create refused by the network limit retryable instead of uncertain', async () => {
    const createNetwork = vi.fn<P2PManagementApi['createNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.network_limit_reached',
      message: 'limit'
    })
    const { accounts } = setup({ createNetwork })
    await accounts.currentUser('service-a')
    const state = accounts.state('service-a')
    state.networkNameDraft = 'Third'
    await accounts.createNetwork('service-a')
    expect(createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', name: 'Third' })
    )
    expect(state.networkWriteUnconfirmed).toBe(false)
    expect(state.networks).toBeUndefined()
  })

  it('clears old user resources when authoritative user identity changes', async () => {
    const { accounts, api } = setup()
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    accounts.select('service-a', 'net-a')
    accounts.state('service-a').renameDrafts['net-a'] = 'draft'
    vi.mocked(api.currentUser).mockResolvedValueOnce({
      ok: true,
      data: { userId: 'user-b', username: 'bob' }
    })
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a')).toMatchObject({
      user: { userId: 'user-b' },
      networks: undefined,
      selectedNetworkId: undefined,
      renameDrafts: {}
    })
  })

  it('retains last readback after a failed list and clears a deleted selection only after successful readback', async () => {
    const { accounts, api } = setup()
    await accounts.networks('service-a')
    accounts.select('service-a', 'net-a')
    vi.mocked(api.networks).mockResolvedValueOnce({
      ok: false,
      code: 'p2p.server_unavailable',
      message: 'unavailable'
    })
    await accounts.networks('service-a')
    expect(accounts.state('service-a').networks).toEqual([network])
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-a')
    vi.mocked(api.networks).mockResolvedValueOnce({ ok: true, data: [] })
    await accounts.networks('service-a')
    expect(accounts.state('service-a').networks).toEqual([])
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
  })

  it('uses actual create/rename identity readback without selecting a default network', async () => {
    const created = { ...network, networkId: 'new-id', name: 'New' }
    const renamed = { ...network, name: 'Renamed' }
    const { accounts } = setup({
      createNetwork: async () => ({ ok: true, data: created }),
      renameNetwork: async () => ({ ok: true, data: renamed })
    })
    await accounts.networks('service-a')
    const state = accounts.state('service-a')
    state.networkNameDraft = 'New'
    await accounts.createNetwork('service-a')
    expect(state.networks).toEqual([network, created])
    expect(state.selectedNetworkId).toBeUndefined()
    state.renameDrafts['net-a'] = 'Renamed'
    await accounts.renameNetwork('service-a', 'net-a')
    expect(state.networks).toEqual([renamed, created])
    expect(state.renameDrafts).toEqual({})
  })

  it('does not remove a network on an uncertain delete, and clears it only on confirmed completion', async () => {
    const deleteNetwork = vi.fn<P2PManagementApi['deleteNetwork']>()
    deleteNetwork
      .mockResolvedValueOnce({
        ok: false,
        code: 'p2p.management_result_unconfirmed',
        message: 'unconfirmed'
      })
      .mockResolvedValueOnce({ ok: true, data: undefined })
    const { accounts } = setup({ deleteNetwork })
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    accounts.select('service-a', 'net-a')
    expect(await accounts.deleteNetwork('service-a', 'net-a')).toBe(false)
    expect(accounts.state('service-a').networks).toEqual([network])
    await accounts.currentUser('service-a')
    expect(await accounts.deleteNetwork('service-a', 'net-a')).toBe(false)
    expect(deleteNetwork).toHaveBeenCalledTimes(1)
    await accounts.networks('service-a')
    expect(await accounts.deleteNetwork('service-a', 'net-a')).toBe(true)
    expect(accounts.state('service-a').networks).toEqual([])
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
    expect(deleteNetwork).toHaveBeenCalledTimes(2)
  })

  it('represents lost logout replies as unknown instead of falsely confirming logout', async () => {
    const { accounts } = setup({
      logout: async () => {
        throw new Error('lost')
      }
    })
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    await accounts.logout('service-a')
    expect(accounts.state('service-a').user).toBeUndefined()
    expect(accounts.state('service-a').networks).toBeUndefined()
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a').user).toEqual(user)
  })

  describe('P2P network device capacity', () => {
    it('dispatches updateNetworkLimit for the signed-in owner and applies the readback', async () => {
      const raised = { ...network, maxDevices: 20 }
      const updateNetworkLimit = vi.fn<P2PManagementApi['updateNetworkLimit']>().mockResolvedValue({
        ok: true,
        data: raised
      })
      const { accounts } = setup({ updateNetworkLimit })
      await accounts.networks('service-a')
      await accounts.raiseNetworkLimit('service-a', 'net-a', 20)
      expect(updateNetworkLimit).toHaveBeenCalledWith(
        expect.objectContaining({ serviceId: 'service-a', networkId: 'net-a', maxDevices: 20 })
      )
      expect(accounts.state('service-a').networks).toEqual([raised])
    })

    it('never sends a lowering or equal capacity update', async () => {
      const updateNetworkLimit = vi.fn<P2PManagementApi['updateNetworkLimit']>()
      const { accounts } = setup({ updateNetworkLimit })
      await accounts.networks('service-a')
      await accounts.raiseNetworkLimit('service-a', 'net-a', 10)
      await accounts.raiseNetworkLimit('service-a', 'net-a', 5)
      expect(updateNetworkLimit).not.toHaveBeenCalled()
    })

    it('treats an unadmitted capacity refusal as retryable, not unconfirmed', async () => {
      const updateNetworkLimit = vi.fn<P2PManagementApi['updateNetworkLimit']>().mockResolvedValue({
        ok: false,
        code: 'p2p.invalid_operation',
        message: 'not exposed by the helper yet'
      })
      const { accounts } = setup({ updateNetworkLimit })
      await accounts.networks('service-a')
      await accounts.raiseNetworkLimit('service-a', 'net-a', 30)
      const state = accounts.state('service-a')
      expect(state.networks).toEqual([network])
      expect(state.networkWriteUnconfirmed).toBe(false)
    })
  })
})
