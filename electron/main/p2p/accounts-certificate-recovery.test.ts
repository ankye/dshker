import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerAccounts } from './accounts'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const deviceId = 'b'.repeat(12)
const user = { userId: 'c'.repeat(12), username: 'selected-owner' }
const networkId = 'd'.repeat(12)
const originalOwner = 'e'.repeat(12)
const token = 'f'.repeat(64)
const active = () => new AbortController().signal

afterEach(() => vi.useRealTimers())

async function fixture() {
  const session = {
    user,
    token,
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  }
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  const accounts = new PeerAccounts({ call }, async () => undefined)
  call.mockResolvedValueOnce(session).mockResolvedValueOnce(user)
  await accounts.login(serviceId, user.username, 'test-only-password', active())
  call.mockClear()
  const projection = {
    user: { ...user },
    networks: [
      {
        networkId,
        userId: user.userId,
        name: 'Selected account network',
        maxDevices: 10,
        devices: [
          {
            deviceId,
            userId: originalOwner,
            name: 'Original device',
            presence: 'offline',
            lastSeen: 0,
            version: '',
            platform: '',
            architecture: ''
          }
        ]
      }
    ]
  }
  const read = (signal = active()) => accounts.certificateRecoveryScope(serviceId, deviceId, signal)
  return { accounts, call, projection, session, read }
}

describe('main-only named certificate recovery projection', () => {
  it('makes one exact named read without ordinary directory fields or cached authority', async () => {
    const f = await fixture()
    f.call.mockResolvedValueOnce(f.projection)
    const result = await f.read()
    expect(result.user).toEqual(user)
    expect(result.networks[0]).toMatchObject({ networkId, userId: user.userId })
    expect(result).not.toHaveProperty('token')
    expect(result).not.toHaveProperty('revision')
    expect(result).not.toHaveProperty('fetchedAt')
    expect(f.call).toHaveBeenCalledExactlyOnceWith(
      'device.certificate_recovery_scope',
      { serviceId, data: { deviceId, token } },
      expect.any(AbortSignal)
    )
    f.call.mockResolvedValueOnce({ ...f.projection, networks: [] })
    expect((await f.read()).networks).toEqual([])
    expect(f.call).toHaveBeenCalledTimes(2)
  })

  it.each(['userId', 'username'] as const)(
    'refuses fresh %s that differs from the captured session',
    async (field) => {
      const f = await fixture()
      f.projection.user[field] = field === 'userId' ? '1'.repeat(12) : 'different-owner'
      f.call.mockResolvedValueOnce(f.projection)
      await expect(f.read()).rejects.toMatchObject({ code: 'p2p.user_scope_mismatch' })
      expect(f.accounts.hasSession(serviceId)).toBe(true)
    }
  )

  it.each([
    'extra',
    'missing',
    'networks',
    'foreign',
    'duplicate-network',
    'duplicate-device',
    'device'
  ] as const)('strictly refuses a %s projection without a substitute read', async (kind) => {
    const f = await fixture()
    const response: Record<string, unknown> = f.projection
    if (kind === 'extra') response.revision = 1
    if (kind === 'missing') delete response.user
    if (kind === 'networks') response.networks = null
    if (kind === 'foreign') f.projection.networks[0].userId = '1'.repeat(12)
    if (kind === 'duplicate-network')
      f.projection.networks.push(structuredClone(f.projection.networks[0]))
    if (kind === 'duplicate-device')
      f.projection.networks[0].devices.push(structuredClone(f.projection.networks[0].devices[0]))
    if (kind === 'device') f.projection.networks[0].devices[0].lastSeen = -1
    f.call.mockResolvedValueOnce(response)
    await expect(f.read()).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate_recovery_scope'
    ])
  })

  it('rejects invalid input, an absent session and an already aborted caller before dispatch', async () => {
    const accounts = new PeerAccounts({ call: vi.fn() }, async () => undefined)
    expect(() => accounts.certificateRecoveryScope(serviceId, 'invalid', active())).toThrow(
      'p2p.invalid_request'
    )
    await expect(
      accounts.certificateRecoveryScope(serviceId, deviceId, active())
    ).rejects.toMatchObject({ code: 'p2p.user_login_required' })
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.read(controller.signal)).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it.each(['abort', 'logout', 'token', 'user', 'close', 'expiry'] as const)(
    'rejects a late projection after %s changes',
    async (change) => {
      const f = await fixture()
      const controller = new AbortController()
      let release!: (value: unknown) => void
      f.call.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const pending = f.read(controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          change === 'close'
            ? 'p2p.helper_unavailable'
            : change === 'expiry'
              ? 'p2p.user_session_expired'
              : 'p2p.request_cancelled'
      })
      if (change === 'abort') controller.abort()
      if (change === 'close') f.accounts.close()
      if (change === 'expiry') {
        vi.useFakeTimers()
        vi.setSystemTime(new Date((f.session.expiresAt + 1) * 1000))
      }
      if (change === 'logout' || change === 'token' || change === 'user') {
        f.call.mockResolvedValueOnce({})
        await f.accounts.logout(serviceId, active())
        if (change !== 'logout') {
          const nextUser =
            change === 'user' ? { userId: '1'.repeat(12), username: 'next-owner' } : user
          f.call
            .mockResolvedValueOnce({ ...f.session, user: nextUser, token: '2'.repeat(64) })
            .mockResolvedValueOnce(nextUser)
          await f.accounts.login(serviceId, nextUser.username, 'test-only-password', active())
        }
      }
      release(f.projection)
      await rejected
      if (change === 'token' || change === 'user')
        expect(f.accounts.sessionToken(serviceId)).toBe('2'.repeat(64))
    }
  )

  it('does not revoke a newer login when an old recovery read returns unauthorized', async () => {
    const f = await fixture()
    let refuse!: (error: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    const pending = f.read()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    f.call.mockResolvedValueOnce({})
    await f.accounts.logout(serviceId, active())
    f.call
      .mockResolvedValueOnce({ ...f.session, token: '2'.repeat(64) })
      .mockResolvedValueOnce(user)
    await f.accounts.login(serviceId, user.username, 'test-only-password', active())
    refuse(new PeerHelperError('p2p.user_unauthorized'))
    await rejected
    expect(f.accounts.sessionToken(serviceId)).toBe('2'.repeat(64))
  })

  it.each(['p2p.user_unauthorized', 'p2p.user_session_expired', 'p2p.server_unavailable'])(
    'preserves %s and never requests an ordinary/public substitute',
    async (code) => {
      const f = await fixture()
      f.call.mockRejectedValueOnce(new PeerHelperError(code))
      await expect(f.read()).rejects.toMatchObject({ code })
      expect(f.call.mock.calls.map(([method]) => method)).toEqual([
        'device.certificate_recovery_scope'
      ])
      expect(f.accounts.hasSession(serviceId)).toBe(code === 'p2p.server_unavailable')
    }
  )
})
