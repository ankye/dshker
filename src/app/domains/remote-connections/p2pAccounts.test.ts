import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type {
  P2PDirectoryView,
  P2PManagementApi,
  P2PNetworkDirectoryView
} from '@/shared/p2p-management'
import { P2P_BUILTIN_SERVICE } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PAccountsDomain } from './p2pAccounts'

const user = { userId: 'user-a', username: 'alice' }
const network = { userId: user.userId, networkId: 'net-a', name: 'Office', maxDevices: 10 }
/** A projected directory row, so a case only has to state the device it cares about. */
function deviceRow(name: string): P2PDirectoryView['devices'][number] {
  return {
    deviceId: 'a'.repeat(12),
    name,
    presence: 'online',
    lastSeen: 1_789_445_714,
    version: '0.1.42',
    platform: 'darwin',
    architecture: 'arm64',
    isLocal: false
  }
}
function networkEntry(networkId: string, name: string): P2PNetworkDirectoryView {
  return {
    networkId,
    userId: user.userId,
    name: 'Office',
    maxDevices: 10,
    devices: [deviceRow(name)]
  }
}
function directoryAnswer(networks: readonly P2PNetworkDirectoryView[]) {
  return {
    ok: true as const,
    data: { known: true, revision: 1, fetchedAt: 1_789_445_714, networks, devices: [] }
  }
}
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

  /**
   * The core owns the directory and announces changes; the renderer projects them.
   *
   * Two machines in one network used to keep a snapshot each and disagree about
   * who was in it, because nothing re-read the list while it was open. A push is
   * what makes the list current without anyone clicking or polling.
   */
  it('projects the directory the core announces', async () => {
    const directory = vi.fn(async () => ({
      ok: true as const,
      data: {
        known: true,
        revision: 2,
        fetchedAt: 1_789_445_714,
        networks: [
          {
            networkId: 'net-a',
            userId: user.userId,
            name: 'Office',
            maxDevices: 10,
            devices: [
              {
                deviceId: 'a'.repeat(12),
                name: 'Mac',
                presence: 'online' as const,
                lastSeen: 1_789_445_714,
                version: '0.1.42',
                platform: 'darwin',
                architecture: 'arm64',
                isLocal: false
              }
            ]
          }
        ],
        devices: []
      }
    }))
    let listener: ((event: { serviceId: string }) => void) | undefined
    const previous = window.dshLauncher
    window.dshLauncher = {
      p2pManagement: {
        onDirectoryChange: (next: (event: { serviceId: string }) => void) => {
          listener = next
          return () => {
            listener = undefined
          }
        }
      }
    } as unknown as DesktopApi
    try {
      const { accounts } = setup({ directory })
      await accounts.readDirectory('service-a')
      expect(listener).toBeDefined()
      // The core reads on its own schedule; the announcement is the only signal
      // the renderer needs, and nobody had to click anything.
      listener?.({ serviceId: 'service-a' })
      await flushPromises()
      expect(directory).toHaveBeenCalled()
      expect(accounts.state('service-a').devices['net-a']?.[0]?.name).toBe('Mac')
    } finally {
      window.dshLauncher = previous
    }
  })

  it('rechecks an unknown account when startup finishes restoring the service session', async () => {
    let notify: (() => void) | undefined
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValueOnce({
        ok: false,
        code: 'p2p.helper_resource_unavailable',
        message: 'starting'
      })
      .mockResolvedValue({ ok: true, data: user })
    const previous = window.dshLauncher
    window.dshLauncher = {
      p2pManagement: {
        currentUser,
        onServiceSessionsChange: (listener: () => void) => {
          notify = listener
          return () => {
            notify = undefined
          }
        }
      }
    } as unknown as DesktopApi
    const { accounts, management } = setup({ currentUser })
    management.selectedServiceId.value = 'service-a'
    try {
      accounts.subscribe()
      await accounts.currentUser('service-a')
      expect(accounts.state('service-a').user).toBeUndefined()
      notify?.()
      await flushPromises()
      expect(accounts.state('service-a').user).toEqual(user)
      expect(currentUser).toHaveBeenCalledTimes(2)
    } finally {
      accounts.stop()
      window.dshLauncher = previous
    }
  })

  it('rechecks a provisional login-required reply after startup restore', async () => {
    let notify: (() => void) | undefined
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValueOnce({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'restore not finished'
      })
      .mockResolvedValue({ ok: true, data: user })
    const previous = window.dshLauncher
    window.dshLauncher = {
      p2pManagement: {
        currentUser,
        onServiceSessionsChange: (listener: () => void) => {
          notify = listener
          return () => {
            notify = undefined
          }
        }
      }
    } as unknown as DesktopApi
    const { accounts, management } = setup({ currentUser })
    management.selectedServiceId.value = 'service-a'
    try {
      accounts.subscribe()
      await accounts.currentUser('service-a')
      expect(accounts.state('service-a').user).toBeNull()
      notify?.()
      await flushPromises()
      expect(accounts.state('service-a').user).toEqual(user)
      expect(currentUser).toHaveBeenCalledTimes(2)
    } finally {
      accounts.stop()
      window.dshLauncher = previous
    }
  })

  it('shares concurrent current-user reads instead of surfacing service busy', async () => {
    let resolve!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    const currentUser = vi.fn<P2PManagementApi['currentUser']>().mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { accounts } = setup({ currentUser })
    const first = accounts.currentUser('service-a')
    const second = accounts.currentUser('service-a')
    resolve({ ok: true, data: user })
    await Promise.all([first, second])
    expect(currentUser).toHaveBeenCalledTimes(1)
    expect(accounts.state('service-a').user).toEqual(user)
  })

  /**
   * A refused read is a fact about the rows on the page, not about the account.
   *
   * Every network the domain already holds is marked failed, so the panel puts the
   * warning where its list is instead of silently keeping rows that may be stale.
   */
  it('surfaces a refused directory read on every network it already holds', async () => {
    const { accounts } = setup({
      directory: vi.fn(async () => ({
        ok: false as const,
        code: 'p2p.user_login_required' as const,
        message: 'no session'
      }))
    })
    const state = accounts.state('service-a')
    state.devices['net-a'] = []
    state.devices['net-b'] = []
    await accounts.readDirectory('service-a')
    expect(state.devicesFailed['net-a']).toBe(true)
    expect(state.devicesFailed['net-b']).toBe(true)
  })

  /**
   * A projection replaces what the page held rather than merging into it.
   *
   * A network the answer no longer carries was deleted or is no longer this
   * account's, so keeping its rows would show devices of a network that is gone.
   */
  it('replaces the projected rows and drops a network the answer no longer carries', async () => {
    const directory = vi
      .fn<P2PManagementApi['directory']>()
      .mockResolvedValueOnce(
        directoryAnswer([networkEntry('net-a', 'Old'), networkEntry('net-b', 'Gone')])
      )
      .mockResolvedValueOnce(directoryAnswer([networkEntry('net-a', 'New')]))
    const { accounts } = setup({ directory })
    await accounts.readDirectory('service-a')
    expect(accounts.state('service-a').devices['net-b']?.[0]?.name).toBe('Gone')
    await accounts.readDirectory('service-a')
    expect(accounts.state('service-a').devices['net-a']?.[0]?.name).toBe('New')
    expect(accounts.state('service-a').devices['net-b']).toBeUndefined()
  })

  /**
   * First launch, already signed in: the account's networks and their devices are
   * there without opening a tab or pressing refresh. Reading them only when the
   * account pane mounted made the list a property of where the read lived rather
   * than of the account — which is what "the list is empty until I click something"
   * looked like on a machine the server already knew.
   */
  it('reads the account and its directory at shell start', async () => {
    const directory = vi.fn(async () => ({
      ok: true as const,
      data: {
        known: true,
        revision: 1,
        fetchedAt: 1_789_445_714,
        networks: [
          {
            networkId: 'net-a',
            userId: user.userId,
            name: 'Office',
            maxDevices: 10,
            devices: [
              {
                deviceId: 'a'.repeat(12),
                name: 'Mac',
                presence: 'online' as const,
                lastSeen: 1_789_445_714,
                version: '0.1.42',
                platform: 'darwin',
                architecture: 'arm64',
                isLocal: false
              }
            ]
          }
        ],
        devices: []
      }
    }))
    const catalog = vi.fn(async () => ({
      ok: true as const,
      data: {
        revision: 'a'.repeat(64),
        catalogId: 'b'.repeat(12),
        services: [{ ...P2P_BUILTIN_SERVICE, serviceId: 'service-a', publicKey: 'pinned-key' }],
        computers: [],
        forgottenServiceIds: []
      }
    }))
    const { accounts } = setup({ catalog, directory })
    await accounts.start()
    const state = accounts.state('service-a')
    expect(state.user).toEqual(user)
    expect(state.networks?.[0]?.networkId).toBe('net-a')
    expect(state.devices['net-a']?.[0]?.name).toBe('Mac')
  })

  /**
   * A busy refusal is another read already in flight, not a failure.
   *
   * The page asks the core for a read when it opens, and the core's own read may
   * still be running; reporting that as a failure put "the last read failed" over a
   * list that was being refreshed at that moment.
   */
  it('does not report a busy directory refresh as a failed read', async () => {
    const { accounts, api } = setup({
      refreshDirectory: vi.fn(async () => ({
        ok: false as const,
        code: 'p2p.service_busy' as const,
        message: 'busy'
      }))
    })
    accounts.state('service-a').devices['net-a'] = []
    await accounts.refreshDirectory('service-a')
    expect(api.refreshDirectory).toHaveBeenCalled()
    expect(accounts.state('service-a').devicesFailed['net-a']).toBeFalsy()
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

  it('publishes a confirmed login before the network list finishes loading', async () => {
    let resolveNetworks!: (value: Awaited<ReturnType<P2PManagementApi['networks']>>) => void
    const networks = vi.fn<P2PManagementApi['networks']>().mockReturnValue(
      new Promise((resolve) => {
        resolveNetworks = resolve
      })
    )
    const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({ ok: true, data: user })
    const { accounts } = setup({ login, networks })

    await accounts.login('service-a', 'alice@example.com', 'login-secret')

    // The session is authoritative now; a slow list must not keep the account
    // looking signed out or keep the password form mounted.
    expect(accounts.state('service-a').user).toEqual(user)
    expect(accounts.state('service-a').networks).toBeUndefined()
    expect(networks).toHaveBeenCalledTimes(1)

    resolveNetworks({ ok: true, data: [network] })
    await flushPromises()
    expect(accounts.state('service-a').networks).toEqual([network])
  })

  it('registers an account and adopts the returned user like a login', async () => {
    const register = vi.fn<P2PManagementApi['register']>().mockResolvedValue({
      ok: true,
      data: user
    })
    const { accounts } = setup({ register })
    await accounts.register('service-a', 'alice@example.com', 'new-secret')
    await flushPromises()
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
