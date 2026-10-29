import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../../src/shared/contracts'
import type { P2PManagementApi, P2PManagementErrorCode } from '../../../src/shared/p2p-management'
import { P2PAccountsDomain } from '../../../src/app/domains/remote-connections/p2pAccounts'
import { P2PManagementDomain } from '../../../src/app/domains/remote-connections/p2pManagement'
import { fixture, serviceId, user } from './tests/management-fixture'
import { PeerCredentialStore } from './credentials'
import { PeerHelperError } from './wire'

vi.mock('electron', () => ({ safeStorage: {} }))
const signal = () => new AbortController().signal
const previous = window.dshLauncher
afterEach(() => (window.dshLauncher = previous))

describe('main-confirmed account session readback', () => {
  it('reads the new real session after an older missing-session reply crossed a service event', async () => {
    const f = fixture()
    let notify!: () => void
    let captured!: () => void
    const oldCaptured = new Promise<void>((resolve) => (captured = resolve))
    let release!: () => void
    let first = true
    const currentUser = vi.fn<P2PManagementApi['currentUser']>(async (request) => {
      let result
      try {
        result = { ok: true as const, data: await f.owner.currentUser(request.serviceId, signal()) }
      } catch (error) {
        if (!(error instanceof PeerHelperError)) throw error
        result = {
          ok: false as const,
          code: error.code as P2PManagementErrorCode,
          message: error.code
        }
      }
      if (first) {
        first = false
        captured()
        await new Promise<void>((resolve) => (release = resolve))
      }
      return result
    })
    const api = {
      currentUser,
      networks: async () => ({ ok: true, data: [] }),
      onServiceSessionsChange: (listener: () => void) => {
        notify = listener
        return () => undefined
      }
    } as unknown as P2PManagementApi
    window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
    const management = new P2PManagementDomain(() => api)
    management.selectedServiceId.value = serviceId
    const accounts = new P2PAccountsDomain(management)
    accounts.subscribe()
    const old = accounts.currentUser(serviceId)
    await oldCaptured
    // This is real main login/session persistence admission against the test's
    // external-core boundary, not a renderer inference from transport online.
    await expect(
      f.owner.login(serviceId, user.username, 'test-only-password', signal())
    ).resolves.toEqual(user)
    notify()
    release()
    await old
    await flushPromises()
    expect(currentUser).toHaveBeenCalledTimes(2)
    expect(accounts.state(serviceId).user).toEqual(user)
    expect(accounts.sessionStatus(serviceId)).toBe('signedIn')
    accounts.stop()
  })

  it('honestly signs out after main has no actual current session', async () => {
    const f = fixture()
    vi.spyOn(PeerCredentialStore.prototype, 'removeUserSession').mockResolvedValue(undefined)
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation((method, payload, active) =>
      method === 'user.logout' ? Promise.resolve({}) : original(method, payload, active)
    )
    await f.owner.login(serviceId, user.username, 'test-only-password', signal())
    const api = {
      currentUser: async () => {
        try {
          return { ok: true, data: await f.owner.currentUser(serviceId, signal()) }
        } catch (error) {
          if (!(error instanceof PeerHelperError)) throw error
          return { ok: false, code: error.code, message: error.code }
        }
      },
      networks: async () => ({ ok: true, data: [] })
    } as unknown as P2PManagementApi
    const accounts = new P2PAccountsDomain(new P2PManagementDomain(() => api))
    await accounts.currentUser(serviceId)
    expect(accounts.sessionStatus(serviceId)).toBe('signedIn')
    await f.owner.logout(serviceId, signal())
    await accounts.currentUser(serviceId)
    expect(accounts.state(serviceId).user).toBeNull()
    expect(accounts.sessionStatus(serviceId)).toBe('signedOut')
  })
})
