import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerAccounts } from './accounts'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(64)
const otherServiceId = 'b'.repeat(64)
const user = { userId: '1'.repeat(32), username: 'test-user' }
const network = { networkId: '2'.repeat(32), userId: user.userId, name: 'Work', maxDevices: 10 }
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

  it('reads the device directory and keeps self-declared telemetry only when displayable', async () => {
    const f = await loggedIn()
    const base = { userId: user.userId, presence: 'online', lastSeen: 1788000000 }
    f.call
      // The ownership check runs first, then the directory read.
      .mockResolvedValueOnce([network])
      .mockResolvedValueOnce([
        {
          ...base,
          deviceId: 'a'.repeat(32),
          name: 'Mac',
          version: '0.1.25',
          platform: 'darwin',
          architecture: 'arm64'
        },
        {
          ...base,
          deviceId: 'b'.repeat(32),
          name: 'Linux box',
          presence: 'stale',
          // Self-declared values that cannot be rendered as-is are dropped to
          // empty rather than refusing the whole directory.
          version: 'x'.repeat(65),
          platform: 'lin\nux',
          architecture: ' arm64'
        }
      ])
    const devices = await f.accounts.listNetworkDevices(serviceId, network.networkId, signal())
    expect(devices[0]).toEqual({
      deviceId: 'a'.repeat(32),
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
  })

  it('refuses a directory row that belongs to another user or reports an impossible state', async () => {
    for (const bad of [
      { userId: '9'.repeat(32), presence: 'online', lastSeen: 0 },
      { userId: user.userId, presence: 'connected', lastSeen: 0 },
      { userId: user.userId, presence: 'online', lastSeen: -1 }
    ]) {
      const f = await loggedIn()
      f.call.mockResolvedValueOnce([network]).mockResolvedValueOnce([
        {
          ...bad,
          deviceId: 'a'.repeat(32),
          name: 'Mac',
          version: '',
          platform: '',
          architecture: ''
        }
      ])
      await expect(
        f.accounts.listNetworkDevices(serviceId, network.networkId, signal())
      ).rejects.toThrow()
    }
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
      f.accounts.enrollmentGrant(serviceId, network.networkId, 'f'.repeat(32), signal())
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
        [field]: field === 'networkId' ? 'f'.repeat(32) : 0
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
    call.mockResolvedValueOnce(session()).mockResolvedValueOnce({ ...user, userId: '3'.repeat(32) })
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
    call.mockResolvedValueOnce([{ ...network, userId: 'f'.repeat(32) }])
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
      .mockResolvedValueOnce([{ ...network, networkId: '4'.repeat(32) }])
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
      accounts.renameNetwork(serviceId, 'f'.repeat(32), 'Other', signal())
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
    const other = { ...network, networkId: '3'.repeat(32), name: 'Other' }
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
