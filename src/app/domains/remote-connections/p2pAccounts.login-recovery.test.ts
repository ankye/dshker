import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  P2P_MANAGEMENT_ERROR_CODES,
  type P2PManagementApi,
  type P2PManagementErrorCode
} from '@/shared/p2p-management'
import { PeerAccounts } from '../../../../electron/main/p2p/accounts'
import { PeerHelperError } from '../../../../electron/main/p2p/wire'
import { P2PAccountsDomain } from './p2pAccounts'
import { P2PManagementDomain } from './p2pManagement'

const serviceId = 'a'.repeat(12)
const user = { userId: 'b'.repeat(12), username: 'account@example.test' }
const session = () => ({
  user,
  token: 'c'.repeat(64),
  expiresAt: Math.floor(Date.now() / 1000) + 300
})
const signal = () => AbortSignal.timeout(5000)

afterEach(() => vi.restoreAllMocks())

function admittedFailure(error: unknown) {
  if (!(error instanceof PeerHelperError)) throw error
  const code = P2P_MANAGEMENT_ERROR_CODES.find((value) => value === error.code)
  if (code === undefined) throw error
  return { ok: false as const, code, message: code }
}

function fixture() {
  const call = vi.fn(async (method: string) => {
    if (method === 'user.login') return session()
    if (method === 'user.current') return user
    if (method === 'user.logout') return {}
    throw new Error('unexpected_authentication_operation')
  })
  const persisted = vi.fn(async () => undefined)
  const owner = new PeerAccounts({ call }, async () => undefined, persisted)
  const api: Pick<
    P2PManagementApi,
    'login' | 'logout' | 'currentUser' | 'networks' | 'accountSelection'
  > = {
    login: vi.fn<P2PManagementApi['login']>(async (request) => {
      try {
        return {
          ok: true,
          data: await owner.login(request.serviceId, request.username, request.password, signal())
        }
      } catch (error) {
        return admittedFailure(error)
      }
    }),
    currentUser: vi.fn<P2PManagementApi['currentUser']>(async (request) => {
      try {
        return { ok: true, data: await owner.currentUser(request.serviceId, signal()) }
      } catch (error) {
        return admittedFailure(error)
      }
    }),
    logout: vi.fn<P2PManagementApi['logout']>(async (request) => {
      try {
        await owner.logout(request.serviceId, signal())
        return { ok: true, data: undefined }
      } catch (error) {
        return admittedFailure(error)
      }
    }),
    networks: vi.fn<P2PManagementApi['networks']>(async () => ({ ok: true, data: [] })),
    accountSelection: vi.fn<P2PManagementApi['accountSelection']>(async () => ({
      ok: true,
      data: { networkId: null }
    }))
  }
  const management = new P2PManagementDomain(() => api as P2PManagementApi)
  const accounts = new P2PAccountsDomain(management)
  const loginThenLoseReply = (code?: P2PManagementErrorCode) =>
    vi.mocked(api.login).mockImplementationOnce(async (request) => {
      await owner.login(request.serviceId, request.username, request.password, signal())
      if (code) return { ok: false, code, message: 'IPC reply was not confirmed' }
      throw new Error('test-only IPC reply loss after authentication committed')
    })
  return { owner, api, call, persisted, management, accounts, loginThenLoseReply }
}

describe('account authentication reply reconciliation', () => {
  it('reads the authenticated owner after a committed login loses its reply', async () => {
    const f = fixture()
    f.loginThenLoseReply()
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.owner.hasSession(serviceId)).toBe(true)
    expect(f.persisted).toHaveBeenCalledTimes(1)
    expect(f.api.login).toHaveBeenCalledTimes(1)
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'user.login',
      'user.current',
      'user.current'
    ])
    expect(f.accounts.state(serviceId).user).toEqual(user)
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedIn')
  })

  it('confirms an already authenticated owner rather than requiring another password submission', async () => {
    const f = fixture()
    await f.owner.login(serviceId, user.username, 'test-only-password', signal())
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'user.login',
      'user.current',
      'user.current'
    ])
    expect(f.persisted).toHaveBeenCalledTimes(1)
    expect(f.accounts.state(serviceId).user).toEqual(user)
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedIn')
  })

  it('reads back a committed login when main reports an unconfirmed cancellation', async () => {
    const f = fixture()
    f.loginThenLoseReply('p2p.management_result_unconfirmed')
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    expect(f.persisted).toHaveBeenCalledTimes(1)
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.accounts.state(serviceId).user).toEqual(user)
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedIn')
  })

  it('does not infer a user from an already-authenticated refusal when the authoritative read fails', async () => {
    const f = fixture()
    await f.owner.login(serviceId, user.username, 'test-only-password', signal())
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.user_unauthorized'))
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.accounts.state(serviceId).user).toBeNull()
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedOut')
    expect(f.owner.hasSession(serviceId)).toBe(false)
  })

  it('keeps a lost write unknown when the subsequent read is transiently unavailable', async () => {
    const f = fixture()
    f.loginThenLoseReply()
    vi.mocked(f.api.currentUser).mockResolvedValueOnce({
      ok: false,
      code: 'p2p.server_unavailable',
      message: 'read unavailable'
    })
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.accounts.state(serviceId).user).toBeUndefined()
    expect(f.accounts.sessionStatus(serviceId)).toBe('unknown')
    expect(f.owner.hasSession(serviceId)).toBe(true)
  })

  it('does not reinterpret rejected credentials as an existing authenticated account', async () => {
    const f = fixture()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.invalid_user_credentials'))
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.api.currentUser).not.toHaveBeenCalled()
    expect(f.accounts.state(serviceId).user).toBeUndefined()
    expect(f.owner.hasSession(serviceId)).toBe(false)
  })

  it('fences a positive reconciliation read after the domain is reset', async () => {
    const f = fixture()
    f.loginThenLoseReply()
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    vi.mocked(f.api.currentUser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const login = f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    f.accounts.stop()
    finish({ ok: true, data: user })
    await login
    await flushPromises()
    expect(f.accounts.state(serviceId).user).toBeUndefined()
    expect(f.accounts.sessionStatus(serviceId)).toBe('unknown')
  })

  it.each(['confirmed', 'unconfirmed'] as const)(
    'ignores a %s login reply delivered after domain teardown',
    async (outcome) => {
      const f = fixture()
      let finish!: (value: Awaited<ReturnType<P2PManagementApi['login']>>) => void
      vi.mocked(f.api.login).mockImplementationOnce(async (request) => {
        await f.owner.login(request.serviceId, request.username, request.password, signal())
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const login = f.accounts.login(serviceId, user.username, 'test-only-password')
      await flushPromises()
      expect(f.owner.hasSession(serviceId)).toBe(true)
      expect(f.persisted).toHaveBeenCalledTimes(1)
      f.accounts.stop()
      finish(
        outcome === 'confirmed'
          ? { ok: true, data: user }
          : {
              ok: false,
              code: 'p2p.management_result_unconfirmed',
              message: 'late unconfirmed reply'
            }
      )
      await login
      expect(f.api.currentUser).not.toHaveBeenCalled()
      expect(f.accounts.state(serviceId).user).toBeUndefined()
      expect(f.accounts.sessionStatus(serviceId)).toBe('unknown')
      expect(f.owner.hasSession(serviceId)).toBe(true)
    }
  )

  it('does not revive a reconciled session from an older read after explicit logout', async () => {
    const f = fixture()
    f.loginThenLoseReply()
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedIn')
    let finish!: (value: { ok: true; data: typeof user }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const older = f.accounts.currentUser(serviceId)
    await f.accounts.logout(serviceId)
    expect(f.api.logout).toHaveBeenCalledTimes(1)
    expect(f.owner.hasSession(serviceId)).toBe(false)
    finish({ ok: true, data: user })
    await older
    expect(f.accounts.state(serviceId).user).toBeNull()
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedOut')
  })

  it('ignores an older signed-out read after the recovered session is confirmed', async () => {
    const f = fixture()
    let finishOld!: (value: { ok: false; code: 'p2p.user_login_required'; message: string }) => void
    vi.spyOn(f.management, 'runRead').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const older = f.accounts.currentUser(serviceId)
    f.loginThenLoseReply()
    await f.accounts.login(serviceId, user.username, 'test-only-password')
    finishOld({ ok: false, code: 'p2p.user_login_required', message: 'old session read' })
    await older
    expect(f.api.currentUser).toHaveBeenCalledTimes(1)
    expect(f.accounts.state(serviceId).user).toEqual(user)
    expect(f.accounts.sessionStatus(serviceId)).toBe('signedIn')
  })

  it('never projects an old service recovery into a newly selected service', async () => {
    const f = fixture()
    f.management.selectedServiceId.value = serviceId
    f.loginThenLoseReply()
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    vi.mocked(f.api.currentUser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const login = f.accounts.login(serviceId, user.username, 'test-only-password')
    await flushPromises()
    const otherService = 'e'.repeat(12)
    f.management.selectedServiceId.value = otherService
    finish({ ok: true, data: user })
    await login
    expect(f.api.currentUser).toHaveBeenCalledWith(expect.objectContaining({ serviceId }))
    expect(f.accounts.state(serviceId).user).toEqual(user)
    expect(f.accounts.state(otherService).user).toBeUndefined()
    expect(f.accounts.sessionStatus(otherService)).toBe('unknown')
  })
})
