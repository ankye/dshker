import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerAccounts } from './accounts'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const user = { userId: '1'.repeat(12), username: 'owner@example.com' }
const token = '7'.repeat(64)
const signal = () => new AbortController().signal
const now = () => Math.floor(Date.now() / 1000)
const renewed = () => ({ user, token, expiresAt: now() + 30 * 86400 })

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  const persist = vi.fn(async () => undefined)
  const accounts = new PeerAccounts({ call }, async () => undefined, persist)
  return { call, persist, accounts }
}

async function loggedIn(days = 1) {
  const f = fixture()
  f.call
    .mockResolvedValueOnce({ user, token, expiresAt: now() + days * 86400 })
    .mockResolvedValueOnce(user)
  await f.accounts.login(serviceId, user.username, 'original-password', signal())
  f.call.mockClear()
  f.persist.mockClear()
  return f
}

describe('canonical account-session renewal', () => {
  it('adopts the server expiry on startup without writing a captured expiry back', async () => {
    const f = fixture()
    f.call.mockResolvedValue(renewed())
    // The server may have committed a renewal whose response was lost before restart.
    expect(await f.accounts.adoptPersistedSession(serviceId, token, now() - 1, signal())).toEqual(
      user
    )
    expect(f.call).toHaveBeenCalledWith(
      'user.renew',
      { serviceId, data: { token } },
      expect.any(AbortSignal)
    )
    expect(f.accounts.hasSession(serviceId)).toBe(true)
    expect(f.persist).not.toHaveBeenCalled()
  })

  it('renews near expiry once and retains the original account and token', async () => {
    const f = await loggedIn()
    let complete!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const first = f.accounts.renewIfDue(serviceId, signal())
    const second = f.accounts.renewIfDue(serviceId, signal())
    expect(second).toBe(first)
    complete(renewed())
    await first
    await f.accounts.renewIfDue(serviceId, signal())
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.accounts.sessionToken(serviceId)).toBe(token)
    expect(f.accounts.currentUserId(serviceId)).toBe(user.userId)
    expect(f.persist).not.toHaveBeenCalled()
  })

  it('does not renew a session outside the seven-day window or invent a missing session', async () => {
    const f = await loggedIn(30)
    await f.accounts.renewIfDue(serviceId, signal())
    await f.accounts.renewIfDue('b'.repeat(12), signal())
    expect(f.call).not.toHaveBeenCalled()
  })

  it('keeps the session on transport or canonical persistence failure and permits a later retry', async () => {
    const f = await loggedIn()
    for (const code of ['p2p.server_unavailable', 'p2p.secret_write_failed']) {
      f.call.mockRejectedValueOnce(new PeerHelperError(code))
      await expect(f.accounts.renewIfDue(serviceId, signal())).rejects.toMatchObject({ code })
      expect(f.accounts.sessionToken(serviceId)).toBe(token)
    }
    f.call.mockResolvedValueOnce(renewed())
    await f.accounts.renewIfDue(serviceId, signal())
    expect(f.accounts.currentUserId(serviceId)).toBe(user.userId)
  })

  it.each([
    { token: '8'.repeat(64) },
    { user: { ...user, userId: '2'.repeat(12) } },
    { expiresAt: now() - 1 }
  ])('refuses changed identity or invalid expiry: %j', async (patch) => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce({ ...renewed(), ...patch })
    await expect(f.accounts.renewIfDue(serviceId, signal())).rejects.toBeInstanceOf(PeerHelperError)
    expect(f.accounts.sessionToken(serviceId)).toBe(token)
  })

  it('cannot adopt a late reply after logout', async () => {
    const f = await loggedIn()
    let complete!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const pending = f.accounts.renewIfDue(serviceId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    f.call.mockResolvedValueOnce({})
    await f.accounts.logout(serviceId, signal())
    complete(renewed())
    await refused
    expect(f.accounts.sessionToken(serviceId)).toBeUndefined()
    expect(f.persist).not.toHaveBeenCalled()
  })

  it('cannot adopt a late reply after close or cancellation', async () => {
    const f = await loggedIn()
    const controller = new AbortController()
    let complete!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const pending = f.accounts.renewIfDue(serviceId, controller.signal)
    const refused = expect(pending).rejects.toBeInstanceOf(PeerHelperError)
    controller.abort()
    f.accounts.close()
    complete(renewed())
    await refused
    expect(f.accounts.sessionToken(serviceId)).toBeUndefined()
  })

  it('does not let an old unauthorized reply clear a newer login', async () => {
    const f = await loggedIn()
    let refuse!: (error: Error) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    const pending = f.accounts.renewIfDue(serviceId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.user_unauthorized' })
    f.call.mockResolvedValueOnce({})
    await f.accounts.logout(serviceId, signal())
    f.call
      .mockResolvedValueOnce({ ...renewed(), token: '9'.repeat(64) })
      .mockResolvedValueOnce(user)
    await f.accounts.login(serviceId, user.username, 'new-password-123', signal())
    refuse(new PeerHelperError('p2p.user_unauthorized'))
    await refused
    expect(f.accounts.sessionToken(serviceId)).toBe('9'.repeat(64))
  })
})

describe('main password-reset boundary', () => {
  it('drops confirmed revoked memory on cleanup failure so explicit sign-in can recover', async () => {
    const f = await loggedIn()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.secret_delete_failed'))
    await expect(
      f.accounts.resetPassword(
        serviceId,
        user.username,
        'a'.repeat(64),
        'new-password-123',
        signal()
      )
    ).rejects.toMatchObject({ code: 'p2p.secret_delete_failed' })
    expect(f.accounts.sessionToken(serviceId)).toBeUndefined()
    f.call
      .mockResolvedValueOnce({ ...renewed(), token: '9'.repeat(64) })
      .mockResolvedValueOnce(user)
    await expect(
      f.accounts.login(serviceId, user.username, 'new-password-123', signal())
    ).resolves.toEqual(user)
    expect(f.accounts.sessionToken(serviceId)).toBe('9'.repeat(64))
  })

  it('clears the same revoked token even when renewal replaced its in-memory object', async () => {
    const f = await loggedIn()
    let complete!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const reset = f.accounts.resetPassword(
      serviceId,
      user.username,
      'a'.repeat(64),
      'new-password-123',
      signal()
    )
    f.call.mockResolvedValueOnce(renewed())
    await f.accounts.renewIfDue(serviceId, signal())
    complete({ reset: true })
    await reset
    expect(f.accounts.hasSession(serviceId)).toBe(false)
    expect(f.accounts.sessionToken(serviceId)).toBeUndefined()
  })

  it('resets through the named operation and clears only a matching account session', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce({ reset: true })
    await f.accounts.resetPassword(
      serviceId,
      user.username,
      'a'.repeat(64),
      'new-password-123',
      signal()
    )
    expect(f.call).toHaveBeenCalledWith(
      'user.resetPassword',
      {
        serviceId,
        data: { email: user.username, code: 'a'.repeat(64), password: 'new-password-123' }
      },
      expect.any(AbortSignal)
    )
    expect(f.accounts.hasSession(serviceId)).toBe(false)
    expect(f.persist).not.toHaveBeenCalled()
  })

  it('does not clear another account or publish an unconfirmed reset', async () => {
    const f = await loggedIn()
    f.call.mockResolvedValueOnce({ reset: true })
    await f.accounts.resetPassword(
      serviceId,
      'other@example.com',
      'a'.repeat(64),
      'new-password-123',
      signal()
    )
    expect(f.accounts.currentUserId(serviceId)).toBe(user.userId)
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.server_unavailable'))
    await expect(
      f.accounts.resetPassword(
        serviceId,
        user.username,
        'a'.repeat(64),
        'new-password-123',
        signal()
      )
    ).rejects.toMatchObject({ code: 'p2p.server_unavailable' })
    expect(f.accounts.currentUserId(serviceId)).toBe(user.userId)
  })

  it('refuses malformed code and password before dispatch', async () => {
    const f = fixture()
    expect(() =>
      f.accounts.resetPassword(serviceId, user.username, 'short', 'new-password-123', signal())
    ).toThrow(PeerHelperError)
    expect(() =>
      f.accounts.resetPassword(serviceId, user.username, 'a'.repeat(64), '短密码', signal())
    ).toThrow(PeerHelperError)
    expect(f.call).not.toHaveBeenCalled()
  })
})
