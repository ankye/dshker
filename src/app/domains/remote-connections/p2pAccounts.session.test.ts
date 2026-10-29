import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { P2PAccountsDomain } from './p2pAccounts'
import { P2PManagementDomain } from './p2pManagement'

const user = { userId: 'user-a', username: 'alice' }
const previous = window.dshLauncher
afterEach(() => {
  window.dshLauncher = previous
  vi.restoreAllMocks()
})

function setup(overrides: Partial<P2PManagementApi> = {}) {
  const api = {
    currentUser: vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValue({ ok: true, data: user }),
    networks: vi.fn<P2PManagementApi['networks']>().mockResolvedValue({ ok: true, data: [] }),
    accountSelection: vi.fn(async () => ({ ok: true, data: { networkId: null } })),
    ...overrides
  } as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  const accounts = new P2PAccountsDomain(management)
  return { api, management, accounts }
}

describe('canonical account session state', () => {
  it('keeps unknown and restoration distinct from a confirmed sign-out', async () => {
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    const f = setup({
      currentUser: vi.fn<P2PManagementApi['currentUser']>(
        () => new Promise((resolve) => (finish = resolve))
      )
    })
    expect(f.accounts.sessionStatus('a')).toBe('unknown')
    const reading = f.accounts.currentUser('a')
    expect(f.accounts.sessionStatus('a')).toBe('restoring')
    finish({ ok: false, code: 'p2p.user_login_required', message: 'absent' })
    await reading
    expect(f.accounts.sessionStatus('a')).toBe('signedOut')
    expect(f.accounts.state('a').user).toBeNull()
  })

  const refreshFailures = [
    'p2p.rate_limited',
    'p2p.helper_busy',
    'p2p.server_unavailable',
    'p2p.helper_resource_unavailable'
  ] as const

  it.each(refreshFailures)(
    'preserves the same confirmed login when currentUser refresh reports %s',
    async (code) => {
      const f = setup()
      await f.accounts.currentUser('a')
      vi.mocked(f.api.currentUser).mockResolvedValueOnce({
        ok: false,
        code,
        message: 'refresh failed'
      })
      await f.accounts.currentUser('a')
      expect(f.api.currentUser).toHaveBeenCalledTimes(2)
      expect(f.accounts.state('a').user).toEqual(user)
      expect(f.accounts.sessionStatus('a')).toBe('signedIn')
      expect(f.management.operations.a).toMatchObject({ phase: 'failed', error: code })
      expect(f.accounts.sessionStatus('b')).toBe('unknown')
    }
  )

  it.each(refreshFailures)(
    'does not infer login from an unread or historical identity when currentUser reports %s',
    async (code) => {
      const f = setup({
        currentUser: vi.fn(async () => ({ ok: false as const, code, message: 'read failed' }))
      })
      await f.accounts.currentUser('a')
      expect(f.accounts.state('a').user).toBeUndefined()
      expect(f.accounts.sessionStatus('a')).toBe('unknown')
      f.accounts.state('b').user = user
      await f.accounts.currentUser('b')
      expect(f.accounts.state('b').user).toEqual(user)
      expect(f.accounts.sessionStatus('b')).toBe('unknown')
    }
  )

  it.each([
    'p2p.user_login_required',
    'p2p.user_session_expired',
    'p2p.user_unauthorized'
  ] as const)('still clears a confirmed login when currentUser reports %s', async (code) => {
    const f = setup()
    await f.accounts.currentUser('a')
    vi.mocked(f.api.currentUser).mockResolvedValueOnce({ ok: false, code, message: 'no session' })
    await f.accounts.currentUser('a')
    expect(f.accounts.state('a').user).toBeNull()
    expect(f.accounts.sessionStatus('a')).toBe('signedOut')
  })

  it('coalesces session announcements during an old read into one fresh session confirmation', async () => {
    let notify!: () => void
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ ok: true, data: user })
    const f = setup({ currentUser })
    f.management.selectedServiceId.value = 'a'
    window.dshLauncher = {
      p2pManagement: {
        onServiceSessionsChange: (listener: () => void) => {
          notify = listener
          return () => undefined
        }
      }
    } as unknown as DesktopApi
    f.accounts.subscribe()
    const reading = f.accounts.currentUser('a')
    notify()
    notify()
    finish({ ok: false, code: 'p2p.user_login_required', message: 'old missing session' })
    await reading
    await flushPromises()
    expect(currentUser).toHaveBeenCalledTimes(2)
    expect(f.accounts.state('a').user).toEqual(user)
    expect(f.accounts.sessionStatus('a')).toBe('signedIn')
    f.accounts.stop()
  })

  it('does not let an old read override or absorb the fresh read after confirmed login', async () => {
    const f = setup()
    let finish!: (value: { ok: false; code: 'p2p.user_login_required'; message: string }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    // A login confirmation is already server-validated by main. Hold the prior
    // renderer read separately to exercise late IPC delivery across that boundary.
    vi.spyOn(f.management, 'run').mockResolvedValueOnce({ ok: true, data: user })
    const old = f.accounts.currentUser('a')
    await f.accounts.login('a', 'alice', 'test-only-password')
    await flushPromises()
    finish({ ok: false, code: 'p2p.user_login_required', message: 'old session' })
    await old
    await flushPromises()
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.accounts.state('a').user).toEqual(user)
    expect(f.accounts.sessionStatus('a')).toBe('signedIn')
  })

  it('does not end a newer restoration when an invalidated older read settles', async () => {
    const f = setup()
    let finishOld!: (value: { ok: false; code: 'p2p.user_login_required'; message: string }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () => new Promise((resolve) => (finishOld = resolve))
    )
    const old = f.accounts.currentUser('a')
    f.accounts.stop()
    let finishNew!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    vi.mocked(f.api.currentUser).mockImplementationOnce(
      () => new Promise((resolve) => (finishNew = resolve))
    )
    const current = f.accounts.currentUser('a')
    finishOld({ ok: false, code: 'p2p.user_login_required', message: 'old session' })
    await old
    expect(f.accounts.sessionStatus('a')).toBe('restoring')
    finishNew({ ok: true, data: user })
    await current
    expect(f.accounts.sessionStatus('a')).toBe('signedIn')
  })

  it('does not sign out when main refuses logout admission as busy', async () => {
    const f = setup({
      logout: vi.fn(async () => ({
        ok: false as const,
        code: 'p2p.service_busy' as const,
        message: 'not admitted'
      }))
    })
    await f.accounts.currentUser('a')
    await f.accounts.logout('a')
    expect(f.accounts.state('a').user).toEqual(user)
    expect(f.accounts.sessionStatus('a')).toBe('signedIn')
  })

  it('does not revive cached authority from a late old read after logout loses its reply', async () => {
    const f = setup()
    await f.accounts.currentUser('a')
    let finish!: (value: { ok: true; data: typeof user }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const old = f.accounts.currentUser('a')
    vi.spyOn(f.management, 'run').mockResolvedValueOnce({
      ok: false,
      code: 'unconfirmed',
      message: 'reply lost after local authority was dropped'
    })
    await f.accounts.logout('a')
    expect(f.accounts.state('a').user).toBeUndefined()
    expect(f.accounts.sessionStatus('a')).toBe('unknown')
    finish({ ok: true, data: user })
    await old
    expect(f.accounts.state('a').user).toBeUndefined()
    expect(f.accounts.sessionStatus('a')).toBe('unknown')
  })

  it('does not restore an old confirmed login from a late transient refusal after logout', async () => {
    const f = setup({ logout: vi.fn(async () => ({ ok: true as const, data: undefined })) })
    await f.accounts.currentUser('a')
    let finish!: (value: { ok: false; code: 'p2p.rate_limited'; message: string }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const old = f.accounts.currentUser('a')
    await f.accounts.logout('a')
    finish({ ok: false, code: 'p2p.rate_limited', message: 'late refresh refusal' })
    await old
    expect(f.accounts.state('a').user).toBeNull()
    expect(f.accounts.sessionStatus('a')).toBe('signedOut')
  })

  it.each([
    'p2p.user_login_required',
    'p2p.user_session_expired',
    'p2p.user_unauthorized'
  ] as const)('confirms signed-out status when logout reports %s', async (code) => {
    const f = setup({
      logout: vi.fn(async () => ({ ok: false as const, code, message: 'no current session' }))
    })
    await f.accounts.currentUser('a')
    await f.accounts.logout('a')
    expect(f.accounts.state('a').user).toBeNull()
    expect(f.accounts.sessionStatus('a')).toBe('signedOut')
  })
})
