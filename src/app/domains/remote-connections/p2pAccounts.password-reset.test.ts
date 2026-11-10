import { afterEach, describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { P2PAccountsDomain } from './p2pAccounts'
import { P2PManagementDomain } from './p2pManagement'

const serviceId = 'a'.repeat(12)
const user = { userId: 'b'.repeat(12), username: 'owner@example.test' }
const recoveryCode = 'c'.repeat(64)
const password = 'new-password-123'
afterEach(() => vi.restoreAllMocks())

function setup() {
  const resetPassword = vi
    .fn<P2PManagementApi['resetPassword']>()
    .mockResolvedValue({ ok: true, data: undefined })
  const api = { resetPassword } as unknown as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  const accounts = new P2PAccountsDomain(management)
  const state = accounts.state(serviceId)
  state.user = user
  state.sessionStatus = 'signedIn'
  state.usernameDraft = user.username
  return { resetPassword, management, accounts, state }
}

describe('password reset account projection', () => {
  it('signs out only the confirmed original service and retains its username without secrets', async () => {
    const f = setup()
    const other = f.accounts.state('d'.repeat(12))
    other.user = { userId: 'e'.repeat(12), username: 'other@example.test' }
    other.sessionStatus = 'signedIn'
    expect(await f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)).toBe(
      true
    )
    expect(f.resetPassword).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      requestId: expect.any(Number),
      serviceId,
      email: user.username,
      code: recoveryCode,
      password
    })
    expect(f.state).toMatchObject({
      user: null,
      sessionStatus: 'signedOut',
      usernameDraft: user.username
    })
    expect(other).toMatchObject({
      user: { userId: 'e'.repeat(12), username: 'other@example.test' },
      sessionStatus: 'signedIn'
    })
    expect(JSON.stringify(f.state)).not.toContain(recoveryCode)
    expect(JSON.stringify(f.management.operations)).not.toContain(password)
    expect(Object.keys(f.management.operations)).toEqual([serviceId])
  })

  it('keeps the prior projection when the coordinator rejects the code', async () => {
    const f = setup()
    f.resetPassword.mockResolvedValueOnce({
      ok: false,
      code: 'p2p.password_reset_invalid',
      message: 'rejected'
    })
    expect(await f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)).toBe(
      false
    )
    expect(f.state.user).toEqual(user)
    expect(f.state.sessionStatus).toBe('signedIn')
  })

  it('does not resubmit an unconfirmed reset or report it as a confirmed sign-out', async () => {
    const f = setup()
    f.resetPassword.mockRejectedValueOnce(new Error('test-only reply loss'))
    expect(await f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)).toBe(
      false
    )
    expect(f.resetPassword).toHaveBeenCalledTimes(1)
    expect(f.management.operations[serviceId]).toMatchObject({
      method: 'resetPassword',
      phase: 'failed',
      error: 'unconfirmed'
    })
    expect(f.state.user).toEqual(user)
    expect(f.state.sessionStatus).toBe('signedIn')
  })

  it('does not publish a late reset after the owning domain stops', async () => {
    const f = setup()
    let finish!: (result: Awaited<ReturnType<P2PManagementApi['resetPassword']>>) => void
    f.resetPassword.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const resetting = f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)
    f.accounts.stop()
    finish({ ok: true, data: undefined })
    expect(await resetting).toBe(false)
    expect(f.state.user).toEqual(user)
    expect(f.state.sessionStatus).toBe('signedIn')
  })

  it('does not replace a newer account projection when its captured revision changes', async () => {
    const f = setup()
    let finish!: (result: Awaited<ReturnType<P2PManagementApi['resetPassword']>>) => void
    f.resetPassword.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const resetting = f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)
    const current = { userId: 'f'.repeat(12), username: 'new-owner@example.test' }
    vi.spyOn(f.management, 'runRead').mockResolvedValueOnce({ ok: true, data: current })
    f.state.networks = []
    await f.accounts.currentUser(serviceId)
    finish({ ok: true, data: undefined })
    expect(await resetting).toBe(false)
    expect(f.state.user).toEqual(current)
    expect(f.state.sessionStatus).toBe('signedIn')
  })

  it('refuses a concurrent reset rather than queueing the secret for another submission', async () => {
    const f = setup()
    let finish!: (result: Awaited<ReturnType<P2PManagementApi['resetPassword']>>) => void
    f.resetPassword.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const first = f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)
    expect(await f.accounts.resetPassword(serviceId, user.username, recoveryCode, password)).toBe(
      false
    )
    expect(f.resetPassword).toHaveBeenCalledTimes(1)
    finish({ ok: true, data: undefined })
    expect(await first).toBe(true)
  })
})
