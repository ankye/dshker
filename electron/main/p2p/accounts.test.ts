import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerAccounts } from './accounts'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const otherServiceId = 'b'.repeat(12)
const user = { userId: '1'.repeat(12), username: 'test-user' }
const network = { networkId: '2'.repeat(12), userId: user.userId, name: 'Work', maxDevices: 10 }
const signal = () => AbortSignal.timeout(5000)
const session = () => ({
  user,
  token: '7'.repeat(64),
  expiresAt: Math.floor(Date.now() / 1000) + 3600
})

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  const cleanup = vi.fn(async (_service: string, _network: string) => undefined)
  return { call, cleanup, accounts: new PeerAccounts({ call }, cleanup) }
}

async function loggedIn() {
  const f = fixture()
  f.call.mockResolvedValueOnce(session()).mockResolvedValueOnce(user)
  await f.accounts.login(serviceId, user.username, 'test-password', signal())
  f.call.mockClear()
  return f
}

/**
 * The core's directory reply for one network.
 *
 * The core is the directory's only owner now, so every device read in this suite
 * answers with this shape rather than a per-network member list.
 */
function directoryReply(
  devices: Record<string, unknown>[],
  options: { known?: boolean; bound?: Record<string, unknown>[]; networkId?: string } = {}
) {
  return {
    serviceId,
    known: options.known ?? true,
    revision: 3,
    fetchedAt: 1789445714,
    networks: [
      {
        networkId: options.networkId ?? network.networkId,
        userId: user.userId,
        name: network.name,
        maxDevices: network.maxDevices,
        devices
      }
    ],
    devices: options.bound ?? []
  }
}

describe('main-owned P2P accounts', () => {
  const email = 'alice@example.com'
  const registered = { userId: user.userId, username: email }

  it('registers, confirms the session by readback and signs the user in', async () => {
    const f = fixture()
    const created = { user: registered, token: '9'.repeat(64), expiresAt: session().expiresAt }
    f.call.mockResolvedValueOnce(created).mockResolvedValueOnce(registered)
    expect(await f.accounts.register(serviceId, email, 'a-long-password', signal())).toEqual(
      registered
    )
    expect(f.call.mock.calls[0]?.[0]).toBe('user.register')
    expect(f.call.mock.calls[0]?.[1]).toEqual({
      serviceId,
      data: { email, password: 'a-long-password' }
    })
    // The session is confirmed by reading the user back, exactly like login.
    expect(f.call.mock.calls[1]?.[0]).toBe('user.current')
    // A confirmed registration leaves the service signed in.
    expect(f.accounts.hasSession(serviceId)).toBe(true)
  })

  it('signs in with the address the coordinator keys the account by', async () => {
    // Every account is keyed by email server side, and the login form is
    // type=email, but the validator required a handle without '@'. That refused
    // every real account with p2p.invalid_request before the request left this
    // process, so signing in was impossible.
    const f = fixture()
    f.call
      .mockResolvedValueOnce({
        user: registered,
        token: '9'.repeat(64),
        expiresAt: session().expiresAt
      })
      .mockResolvedValueOnce(registered)
    expect(await f.accounts.login(serviceId, email, 'a-long-password', signal())).toEqual(
      registered
    )
    expect(f.call.mock.calls[0]?.[1]).toEqual({
      serviceId,
      data: { username: email, password: 'a-long-password' }
    })
    expect(f.accounts.hasSession(serviceId)).toBe(true)
  })

  it('still refuses a value no coordinator would accept as a login name', async () => {
    // Widening to accept an address must not turn the check off: a value with
    // control characters or no plausible shape is stopped before the password
    // leaves this process.
    const f = fixture()
    // The guard runs before any promise is returned, so the throw is synchronous.
    for (const bad of ['', 'a', 'no-at-sign-but-way-too-'.repeat(20), 'has space@example.com']) {
      expect(() => f.accounts.login(serviceId, bad, 'a-long-password', signal())).toThrow(
        'p2p.invalid_request'
      )
    }
    expect(f.call).not.toHaveBeenCalled()
  })

  it('never returns the session token to the caller after registering', async () => {
    const f = fixture()
    const token = '9'.repeat(64)
    f.call.mockResolvedValueOnce({ user: registered, token, expiresAt: session().expiresAt })
    f.call.mockResolvedValueOnce(registered)
    const result = await f.accounts.register(serviceId, email, 'a-long-password', signal())
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('a-long-password')
  })

  it('refuses a registration the coordinator would reject before sending it', async () => {
    const f = fixture()
    // Input is validated before any request is built, so these throw directly.
    for (const [address, password] of [
      ['not-an-email', 'a-long-password'],
      ['alice@example.com', 'short'],
      ['', 'a-long-password']
    ] as const)
      expect(() => f.accounts.register(serviceId, address, password, signal())).toThrow(
        'p2p.invalid_request'
      )
    expect(f.call).not.toHaveBeenCalled()
  })

  it('reports a refused registration and leaves the service signed out', async () => {
    const f = fixture()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.user_conflict'))
    await expect(
      f.accounts.register(serviceId, email, 'a-long-password', signal())
    ).rejects.toMatchObject({ code: 'p2p.user_conflict' })
    expect(f.accounts.hasSession(serviceId)).toBe(false)
  })

  it('reads the device directory from the core and keeps self-declared telemetry only when displayable', async () => {
    const f = await loggedIn()
    const base = { userId: user.userId, presence: 'online', lastSeen: 1788000000 }
    f.call.mockResolvedValueOnce(
      directoryReply([
        {
          ...base,
          deviceId: 'a'.repeat(12),
          name: 'Mac',
          version: '0.1.25',
          platform: 'darwin',
          architecture: 'arm64'
        },
        {
          ...base,
          deviceId: 'b'.repeat(12),
          name: 'Linux box',
          presence: 'stale',
          // Self-declared values that cannot be rendered as-is are dropped to
          // empty rather than refusing the whole directory.
          version: 'x'.repeat(65),
          platform: 'lin\nux',
          architecture: ' arm64'
        }
      ])
    )
    const devices = await f.accounts.listNetworkDevices(serviceId, network.networkId, signal())
    expect(devices[0]).toEqual({
      deviceId: 'a'.repeat(12),
      userId: user.userId,
      name: 'Mac',
      presence: 'online',
      lastSeen: 1788000000,
      version: '0.1.25',
      platform: 'darwin',
      architecture: 'arm64'
    })
    // A stale heartbeat is not usable, and the unusable strings became empty.
    expect(devices[1]).toMatchObject({
      presence: 'offline',
      version: '',
      platform: '',
      architecture: ''
    })
    // The core owns one snapshot, so this read never becomes a per-network
    // coordinator round trip that a second machine could answer differently.
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['directory.inspect'])
    expect(f.call.mock.calls[0][1]).toEqual({ serviceId, data: {} })
  })

  it('refuses a directory row that reports an impossible state', async () => {
    for (const bad of [
      { userId: user.userId, presence: 'connected', lastSeen: 0 },
      { userId: user.userId, presence: 'online', lastSeen: -1 }
    ]) {
      const f = await loggedIn()
      f.call.mockResolvedValueOnce(
        directoryReply([
          {
            ...bad,
            deviceId: 'a'.repeat(12),
            name: 'Mac',
            version: '',
            platform: '',
            architecture: ''
          }
        ])
      )
      await expect(
        f.accounts.listNetworkDevices(serviceId, network.networkId, signal())
      ).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
    }
  })

  it('reports an unread directory as a state and refuses an unknown network instead of an empty list', async () => {
    const f = await loggedIn()
    const unread = { serviceId, known: false, revision: 0, fetchedAt: 0, networks: [], devices: [] }
    f.call.mockResolvedValueOnce(unread)
    // `known:false` is the core saying it has not read yet, which is not an error.
    expect(await f.accounts.directory(serviceId, signal())).toEqual({
      known: false,
      revision: 0,
      fetchedAt: 0,
      networks: [],
      devices: []
    })
    f.call.mockResolvedValueOnce(unread)
    // An empty list would claim the network has no devices, which is a different
    // and misleading statement, so an absent network stays a refusal.
    await expect(
      f.accounts.listNetworkDevices(serviceId, network.networkId, signal())
    ).rejects.toMatchObject({ code: 'p2p.network_unavailable' })
  })

  it('answers the two directory operations from the core without a per-page read', async () => {
    const f = await loggedIn()
    f.call
      .mockResolvedValueOnce(directoryReply([], { bound: [] }))
      .mockResolvedValueOnce(directoryReply([], { bound: [] }))
    expect(await f.accounts.directory(serviceId, signal())).toEqual({
      known: true,
      revision: 3,
      fetchedAt: 1789445714,
      networks: [
        {
          networkId: network.networkId,
          userId: user.userId,
          name: network.name,
          maxDevices: network.maxDevices,
          devices: []
        }
      ],
      devices: []
    })
    expect((await f.accounts.refreshDirectory(serviceId, signal())).known).toBe(true)
    // inspect reads the snapshot, refresh reads the coordinator first: neither
    // reaches for networks.devices or devices.list.
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'directory.inspect',
      'directory.refresh'
    ])
  })

  /**
   * A row's own `userId` is the account that first enrolled the machine, while the
   * directory is already scoped to the reader by the coordinator. A machine bound
   * to two accounts keeps the first account's name, so treating that column as a
   * scope violation made the entire directory unreadable exactly in the case this
   * product now supports.
   */
  it('reads a machine that another account enrolled first', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce(
      directoryReply([
        {
          deviceId: 'a'.repeat(12),
          userId: '9'.repeat(12),
          name: 'Shared laptop',
          presence: 'online',
          lastSeen: 1788000000,
          version: '',
          platform: '',
          architecture: ''
        }
      ])
    )

    const devices = await f.accounts.listNetworkDevices(serviceId, network.networkId, signal())

    expect(devices).toEqual([
      {
        deviceId: 'a'.repeat(12),
        // The account this list was read for, which is the only scope it has.
        userId: user.userId,
        name: 'Shared laptop',
        presence: 'online',
        lastSeen: 1788000000,
        version: '',
        platform: '',
        architecture: ''
      }
    ])
  })

  /**
   * The account's own device list is how the app answers "does this machine belong
   * to the account signed in here?" — a device id can be bound to several accounts,
   * so nothing stored locally can answer it.
   */
  it('lists the devices bound to the signed-in account', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce(
      directoryReply([], {
        bound: [
          {
            deviceId: 'c'.repeat(12),
            userId: '9'.repeat(12),
            name: 'This machine',
            presence: 'online',
            lastSeen: 1788000001,
            version: '',
            platform: '',
            architecture: ''
          }
        ]
      })
    )

    const devices = await f.accounts.listDevices(serviceId, signal())

    expect(f.call).toHaveBeenCalledWith(
      'directory.inspect',
      { serviceId, data: {} },
      expect.any(AbortSignal)
    )
    // The account's own bindings come from the core's snapshot too: devices.list
    // was the other per-page coordinator read a second machine could answer
    // differently.
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('devices.list')
    expect(devices.map((device) => device.deviceId)).toEqual(['c'.repeat(12)])
  })

  it('refuses a directory reply that is not a directory', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce({ devices: [] })

    await expect(f.accounts.listDevices(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.invalid_server_response'
    })
  })

  it('reports the signed-in account for the device identity', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce({})

    expect(f.accounts.currentUserId(serviceId)).toBe(user.userId)
    await f.accounts.logout(serviceId, signal())
    // The device identity has no account to report once nobody is signed in.
    expect(f.accounts.currentUserId(serviceId)).toBeUndefined()
  })

  it('raises an owned network capacity and confirms it through readback', async () => {
    const f = await loggedIn()
    const raised = { ...network, maxDevices: 20 }
    f.call
      .mockResolvedValueOnce([network])
      .mockResolvedValueOnce(raised)
      .mockResolvedValueOnce([raised])
    expect(await f.accounts.updateNetworkLimit(serviceId, network.networkId, 20, signal())).toEqual(
      raised
    )
    expect(f.call.mock.calls[1]?.[0]).toBe('networks.limit')

    // A value outside the allowed set never reaches the coordinator.
    const g = await loggedIn()
    expect(() => g.accounts.updateNetworkLimit(serviceId, network.networkId, 15, signal())).toThrow(
      'p2p.invalid_network_limit'
    )
    expect(g.call).not.toHaveBeenCalled()
  })

  it('clears rejected user authority so explicit login can recover without restarting the app', async () => {
    const f = await loggedIn()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.user_unauthorized'))
    await expect(f.accounts.currentUser(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_unauthorized'
    })
    await expect(f.accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_login_required'
    })
    expect(f.call).toHaveBeenCalledTimes(1)
    f.call.mockResolvedValueOnce(session()).mockResolvedValueOnce(user)
    expect(await f.accounts.login(serviceId, user.username, 'new-password', signal())).toEqual(user)
  })

  it('does not discard user authority on an ordinary server connection failure', async () => {
    const f = await loggedIn()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.server_unavailable'))
    await expect(f.accounts.currentUser(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.server_unavailable'
    })
    f.call.mockResolvedValueOnce(user)
    expect(await f.accounts.currentUser(serviceId, signal())).toEqual(user)
  })
  it('issues a main-only enrollment grant only for the original user and owned network', async () => {
    const f = await loggedIn()
    const grant = {
      token: '8'.repeat(64),
      networkId: network.networkId,
      expiresAt: Math.floor(Date.now() / 1000) + 300
    }
    f.call.mockResolvedValueOnce([network]).mockResolvedValueOnce(grant)
    expect(
      await f.accounts.enrollmentGrant(serviceId, network.networkId, user.userId, signal())
    ).toEqual(grant)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'networks.list',
      'device.enrollmentToken'
    ])
    expect(f.call.mock.calls[1][1]).toEqual({
      serviceId,
      data: { token: session().token, networkId: network.networkId }
    })
  })

  it('does not issue a grant after the pending enrollment user changes', async () => {
    const f = await loggedIn()
    await expect(
      f.accounts.enrollmentGrant(serviceId, network.networkId, 'f'.repeat(12), signal())
    ).rejects.toMatchObject({ code: 'p2p.user_scope_mismatch' })
    expect(f.call).not.toHaveBeenCalled()
    f.call.mockResolvedValueOnce([])
    await expect(
      f.accounts.enrollmentGrant(serviceId, network.networkId, user.userId, signal())
    ).rejects.toMatchObject({ code: 'p2p.network_unavailable' })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['networks.list'])
  })

  it.each(['networkId', 'expiresAt', 'extra'])(
    'rejects a malformed enrollment grant %s',
    async (field) => {
      const f = await loggedIn()
      const grant = {
        token: '8'.repeat(64),
        networkId: network.networkId,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        [field]: field === 'networkId' ? 'f'.repeat(12) : 0
      }
      f.call.mockResolvedValueOnce([network]).mockResolvedValueOnce(grant)
      await expect(
        f.accounts.enrollmentGrant(serviceId, network.networkId, user.userId, signal())
      ).rejects.toThrow()
    }
  )
  it('returns only the independently read-back user, never password or session token', async () => {
    const { accounts, call } = fixture()
    const value = session()
    call.mockResolvedValueOnce(value).mockResolvedValueOnce(user)
    const result = await accounts.login(serviceId, user.username, 'test-password', signal())
    expect(result).toEqual(user)
    expect(Object.keys(result).sort()).toEqual(['userId', 'username'])
    expect(JSON.stringify(result)).not.toContain(value.token)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['user.login', 'user.current'])
    expect(call.mock.calls[1][1]).toEqual({ serviceId, data: { token: value.token } })
  })

  it('does not admit a mismatched login readback or retain its session', async () => {
    const { accounts, call } = fixture()
    call.mockResolvedValueOnce(session()).mockResolvedValueOnce({ ...user, userId: '3'.repeat(12) })
    await expect(
      accounts.login(serviceId, user.username, 'test-password', signal())
    ).rejects.toMatchObject({ code: 'p2p.user_scope_mismatch' })
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_login_required'
    })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('isolates operation locks by service and rejects duplicate requests', async () => {
    const { accounts, call } = fixture()
    let resolveFirst!: (value: unknown) => void
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const pending = accounts.login(serviceId, user.username, 'test-password', signal())
    await expect(
      accounts.login(serviceId, user.username, 'test-password', signal())
    ).rejects.toMatchObject({ code: 'p2p.service_busy' })
    call.mockResolvedValueOnce(session()).mockResolvedValueOnce(user)
    expect(await accounts.login(otherServiceId, user.username, 'test-password', signal())).toEqual(
      user
    )
    call.mockResolvedValueOnce(user)
    resolveFirst(session())
    expect(await pending).toEqual(user)
  })

  it('prevents a late successful response from restoring credentials after helper closure', async () => {
    const { accounts, call } = fixture()
    let resolve!: (value: unknown) => void
    call.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete
        })
    )
    const pending = accounts.login(serviceId, user.username, 'test-password', signal())
    accounts.close()
    resolve(session())
    await expect(pending).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    await expect(accounts.currentUser(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.helper_unavailable'
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('expires local user authority without sending the stale token', async () => {
    const { accounts, call } = await loggedIn()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 3_601_000)
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_session_expired'
    })
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_login_required'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects cross-user and duplicate network records', async () => {
    const { accounts, call } = await loggedIn()
    call.mockResolvedValueOnce([{ ...network, userId: 'f'.repeat(12) }])
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_scope_mismatch'
    })
    call.mockResolvedValueOnce([network, network])
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.invalid_network_list'
    })
  })

  it('reads back a created network by identity, owner and exact name', async () => {
    const { accounts, call } = await loggedIn()
    call.mockResolvedValueOnce(network).mockResolvedValueOnce([network])
    expect(await accounts.createNetwork(serviceId, network.name, signal())).toEqual(network)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['networks.create', 'networks.list'])
    expect(call.mock.calls[0][1]).toEqual({
      serviceId,
      data: { token: '7'.repeat(64), name: network.name }
    })
  })

  it('reports uncertain create readback and never repeats a write', async () => {
    const { accounts, call } = await loggedIn()
    call
      .mockResolvedValueOnce(network)
      .mockResolvedValueOnce([{ ...network, networkId: '4'.repeat(12) }])
    await expect(accounts.createNetwork(serviceId, network.name, signal())).rejects.toMatchObject({
      code: 'p2p.management_result_unconfirmed'
    })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['networks.create', 'networks.list'])
  })

  it('does not write a no-op name and does not rename an unowned network', async () => {
    const { accounts, call } = await loggedIn()
    call.mockResolvedValueOnce([network])
    expect(
      await accounts.renameNetwork(serviceId, network.networkId, network.name, signal())
    ).toEqual(network)
    call.mockResolvedValueOnce([network])
    await expect(
      accounts.renameNetwork(serviceId, 'f'.repeat(12), 'Other', signal())
    ).rejects.toMatchObject({ code: 'p2p.network_unavailable' })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['networks.list', 'networks.list'])
  })

  it('renames only the exact owned network and verifies the persisted result', async () => {
    const { accounts, call } = await loggedIn()
    const changed = { ...network, name: '新网络' }
    call
      .mockResolvedValueOnce([network])
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce([changed])
    expect(
      await accounts.renameNetwork(serviceId, network.networkId, changed.name, signal())
    ).toEqual(changed)
    expect(call.mock.calls[1][1]).toEqual({
      serviceId,
      data: { token: '7'.repeat(64), networkId: network.networkId, name: changed.name }
    })
  })

  it('cleans the removed network before readback without affecting other networks', async () => {
    const { accounts, call, cleanup } = await loggedIn()
    const other = { ...network, networkId: '3'.repeat(12), name: 'Other' }
    call.mockResolvedValueOnce([network, other]).mockResolvedValueOnce({})
    call.mockImplementationOnce(async () => {
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(serviceId, network.networkId)
      return [other]
    })
    await accounts.deleteNetwork(serviceId, network.networkId, signal())
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'networks.list',
      'networks.delete',
      'networks.list'
    ])
  })

  it('retains confirmed revocation cleanup when the final readback fails', async () => {
    const { accounts, call, cleanup } = await loggedIn()
    call
      .mockResolvedValueOnce([network])
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new PeerHelperError('p2p.server_unavailable'))
    await expect(
      accounts.deleteNetwork(serviceId, network.networkId, signal())
    ).rejects.toMatchObject({ code: 'p2p.server_unavailable' })
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(serviceId, network.networkId)
    expect(call.mock.calls.filter(([method]) => method === 'networks.delete')).toHaveLength(1)
  })

  it('clears local login on failed logout without claiming server revocation succeeded', async () => {
    const { accounts, call } = await loggedIn()
    call.mockRejectedValueOnce(new PeerHelperError('p2p.server_unavailable'))
    await expect(accounts.logout(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.server_unavailable'
    })
    await expect(accounts.listNetworks(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.user_login_required'
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rejects cancelled operations before sending any request', async () => {
    const { accounts, call } = await loggedIn()
    await expect(accounts.listNetworks(serviceId, AbortSignal.abort())).rejects.toMatchObject({
      code: 'p2p.request_cancelled'
    })
    expect(call).not.toHaveBeenCalled()
  })
})
