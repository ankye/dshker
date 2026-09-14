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
    // Nothing is remembered until a case says so, which is also the first-run state.
    accountSelection: vi.fn(async () => ({ ok: true as const, data: { networkId: null } })),
    rememberAccountSelection: vi.fn(async () => ({ ok: true as const, data: undefined })),
    ...overrides
  } as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  return { api, management, accounts: new P2PAccountsDomain(management) }
}

describe('P2P user and network domain', () => {
  it('clears authority for any refusal that means there is no session', async () => {
    // A hard-coded list of three codes left every other signed-out refusal in a
    // half state: neither accepted nor cleared, so the panel kept showing a
    // signed-in view it could not act on.
    const { accounts, api } = setup()
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a').user).toEqual(user)
    vi.mocked(api.currentUser).mockResolvedValueOnce({
      ok: false,
      code: 'p2p.user_unauthorized',
      message: 'no'
    })
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a').user).toBeNull()
  })

  it('does not claim a sign-out when the refusal says nothing about the session', async () => {
    // A missing helper is not evidence the user was signed out. Reporting it as
    // one would discard authority the coordinator still honours.
    const { accounts, api } = setup()
    await accounts.currentUser('service-a')
    vi.mocked(api.currentUser).mockResolvedValueOnce({
      ok: false,
      code: 'p2p.helper_resource_unavailable',
      message: 'no helper'
    })
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a').user).toEqual(user)
  })

  it('selects the only network, still never matches a name, and keeps IDs', async () => {
    const { accounts } = setup()
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    // One network is not a choice, so selecting it removes a click that carried
    // no decision. Several networks are covered by the next case.
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-a')
    await accounts.select('service-a', 'Office')
    // A display name is still never a key: the selection stays where it was.
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-a')
    await accounts.select('service-a', 'net-a')
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-a')
    expect(accounts.state('service-b').networks).toBeUndefined()
  })

  it('restores the network this account chose by hand', async () => {
    const other = { ...network, networkId: 'net-b', name: 'Lab' }
    const { accounts, api } = setup({
      networks: vi.fn(async () => ({ ok: true as const, data: [network, other] })),
      accountSelection: vi.fn(async () => ({ ok: true as const, data: { networkId: 'net-b' } }))
    })
    await accounts.currentUser('service-a')
    expect(accounts.state('service-a').selectedNetworkId).toBe('net-b')
    // The memory is read for the signed-in account, never for the machine.
    expect(api.accountSelection).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', userId: user.userId })
    )
  })

  it('ignores a remembered network that is gone, and then never guesses', async () => {
    const other = { ...network, networkId: 'net-b', name: 'Lab' }
    const { accounts } = setup({
      networks: vi.fn(async () => ({ ok: true as const, data: [network, other] })),
      accountSelection: vi.fn(async () => ({ ok: true as const, data: { networkId: 'net-gone' } }))
    })
    await accounts.networks('service-a')
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
  })

  it('remembers only an explicit selection', async () => {
    const { accounts, api } = setup()
    await accounts.currentUser('service-a')
    // The single network was selected for the owner; that default is not a choice.
    expect(api.rememberAccountSelection).not.toHaveBeenCalled()
    await accounts.select('service-a', 'net-a')
    expect(api.rememberAccountSelection).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', userId: user.userId, networkId: 'net-a' })
    )
  })

  it('leaves the choice to the user when several networks exist', async () => {
    const other = { ...network, networkId: 'net-b', name: 'Lab' }
    const { accounts } = setup({
      networks: vi.fn(async () => ({ ok: true as const, data: [network, other] }))
    })
    await accounts.networks('service-a')
    // Two candidates: picking either one would be a guess about where the next
    // edit, limit raise or delete lands.
    expect(accounts.state('service-a').selectedNetworkId).toBeUndefined()
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
    // A confirmed registration is a session, so it loads its networks exactly
    // like a sign-in rather than leaving the new account looking empty.
    expect(accounts.state('service-a').networks).toEqual([network])
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
    // The refused create leaves the list as the session loaded it: a rejection
    // is a known outcome, so it neither invalidates nor re-reads the record.
    expect(state.networks).toEqual([network])
  })

  it('clears old user resources when authoritative user identity changes', async () => {
    const { accounts, api } = setup()
    await accounts.currentUser('service-a')
    await accounts.networks('service-a')
    await accounts.select('service-a', 'net-a')
    accounts.state('service-a').renameDrafts['net-a'] = 'draft'
    vi.mocked(api.currentUser).mockResolvedValueOnce({
      ok: true,
      data: { userId: 'user-b', username: 'bob' }
    })
    await accounts.currentUser('service-a')
    // The new identity's own list is read immediately, so the assertion is that
    // nothing from the previous user survives: no draft, and the selection is the
    // new user's own single network rather than an inherited pick.
    expect(accounts.state('service-a')).toMatchObject({
      user: { userId: 'user-b' },
      selectedNetworkId: 'net-a',
      renameDrafts: {}
    })
    // Once for the first session, once for the explicit call, once for user-b.
    expect(api.networks).toHaveBeenCalledTimes(3)
  })

  it('retains last readback after a failed list and clears a deleted selection only after successful readback', async () => {
    const { accounts, api } = setup()
    await accounts.networks('service-a')
    await accounts.select('service-a', 'net-a')
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

  it('uses actual create/rename identity readback and never moves the selection', async () => {
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
    // The sole network was selected on read; creating a second one does not move
    // an existing selection.
    expect(state.selectedNetworkId).toBe('net-a')
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
    await accounts.select('service-a', 'net-a')
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
