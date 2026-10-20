import { describe, expect, it, vi } from 'vitest'
import { PeerCredentialStore } from './credentials'
import { P2PSelectionStore } from './selection-preferences'
import { PeerHelperError } from './wire'
import { fixture, serviceId, user } from './tests/management-fixture'
import {
  legacyCertificateFixture,
  legacyCredential,
  recoveryNetworkId,
  recoveredCertificate
} from './tests/legacy-certificate-fixture'

vi.mock('electron', () => ({ safeStorage: {} }))

function enrolledLegacy() {
  const f = fixture()
  const legacy = legacyCertificateFixture({ ...legacyCredential, userId: user.userId })
  vi.spyOn(PeerCredentialStore.prototype, 'load').mockImplementation(legacy.load)
  vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockImplementation(async () => ({
    kind: 'registered',
    ...legacy.stored()
  }))
  vi.spyOn(PeerCredentialStore.prototype, 'replace').mockImplementation(legacy.replace)
  let selection: { userId: string; networkId: string } | undefined
  const remembered = vi
    .spyOn(P2PSelectionStore.prototype, 'remembered')
    .mockImplementation(async (_service, userId) =>
      selection?.userId === userId ? selection.networkId : undefined
    )
  const remember = vi
    .spyOn(P2PSelectionStore.prototype, 'remember')
    .mockImplementation(async (_service, userId, networkId) => {
      selection = { userId, networkId }
    })
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, payload, signal) => {
    if (method === 'device.certificate' || method === 'device.restore')
      return legacy.call(method, payload, signal)
    if (method === 'device.certificate_recovery_scope')
      return {
        user,
        networks: legacy.directory.networks.map((network) => ({ ...network, userId: user.userId }))
      }
    if (method === 'directory.refresh')
      return {
        serviceId,
        ...structuredClone(legacy.directory),
        networks: legacy.directory.networks.map((network) => ({ ...network, userId: user.userId })),
        devices: structuredClone(legacy.directory.networks[0].devices)
      }
    return original(method, payload, signal)
  })
  const login = () =>
    f.owner.login(serviceId, user.username, 'test-only-password', new AbortController().signal)
  const settled = (state: 'online' | 'offline', code: string) =>
    vi.waitFor(async () =>
      expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state, code }])
    )
  return { ...f, legacy, remembered, remember, login, settled }
}

describe('manual legacy certificate recovery maintenance', () => {
  it('recovers after an explicit manual selection without another login or enrollment', async () => {
    const f = enrolledLegacy()
    await expect(f.login()).resolves.toEqual(user)
    await f.settled('offline', 'p2p.certificate_recovery_required')
    expect(f.legacy.stored().credential).not.toHaveProperty('networkId')
    await f.owner.rememberAccountSelection(serviceId, user.userId, recoveryNetworkId)
    await f.settled('online', '')
    expect(f.remember).toHaveBeenCalledExactlyOnceWith(serviceId, user.userId, recoveryNetworkId)
    expect(f.remembered).toHaveBeenCalledWith(serviceId, user.userId)
    expect(f.legacy.stored().credential).toEqual({
      ...legacyCredential,
      userId: user.userId,
      certificate: recoveredCertificate
    })
    expect(f.legacy.stored().credential).not.toHaveProperty('networkId')
    expect(f.call.mock.calls.filter(([method]) => method === 'user.login')).toHaveLength(1)
    expect(f.call.mock.calls.filter(([method]) => method === 'device.certificate')).toHaveLength(3)
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('device.enroll')
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('user.logout')
    expect(f.runtimeStart).not.toHaveBeenCalled()
    await expect(f.owner.currentUser(serviceId, new AbortController().signal)).resolves.toEqual(
      user
    )
  })

  it('keeps the restored device session when an online account explicitly changes selection', async () => {
    const f = enrolledLegacy()
    f.legacy.setCanonical(legacyCredential.certificate)
    await f.login()
    await f.settled('online', '')
    f.remembered.mockClear()
    await f.owner.rememberAccountSelection(serviceId, user.userId, '1'.repeat(12))
    await vi.waitFor(() =>
      expect(f.call.mock.calls.filter(([method]) => method === 'device.certificate')).toHaveLength(
        2
      )
    )
    expect(f.remembered).not.toHaveBeenCalled()
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
    expect(f.legacy.replace).not.toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('cancels prior scope verification and queues the newly selected network in the same lifecycle', async () => {
    const f = enrolledLegacy()
    const nextNetworkId = '1'.repeat(12)
    f.legacy.directory.networks.push({
      ...f.legacy.directory.networks[0],
      networkId: nextNetworkId
    })
    await f.remember(serviceId, user.userId, recoveryNetworkId)
    const original = f.call.getMockImplementation()!
    let release!: () => void
    let scopeReads = 0
    f.call.mockImplementation(async (method, payload, signal) => {
      if (method === 'device.certificate_recovery_scope' && ++scopeReads === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (
        method === 'device.certificate' &&
        (payload as { data: { networkId?: string } }).data.networkId === nextNetworkId
      )
        f.legacy.setCanonical(recoveredCertificate)
      return original(method, payload, signal)
    })
    await f.login()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.owner.rememberAccountSelection(serviceId, user.userId, nextNetworkId)
    release()
    await f.settled('online', '')
    const scoped = f.call.mock.calls.filter(
      ([method, payload]) =>
        method === 'device.certificate' &&
        (payload as { data: { networkId?: string } }).data.networkId !== undefined
    )
    expect(scoped).toHaveLength(1)
    expect(scoped[0][1]).toHaveProperty('data.networkId', nextNetworkId)
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
    expect(f.legacy.stored().credential).not.toHaveProperty('networkId')
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('refuses a selection remembered for another user while retaining the current valid login', async () => {
    const f = enrolledLegacy()
    await f.login()
    await f.settled('offline', 'p2p.certificate_recovery_required')
    f.call.mockClear()
    await f.owner.rememberAccountSelection(serviceId, '1'.repeat(12), recoveryNetworkId)
    await vi.waitFor(() =>
      expect(f.call.mock.calls.filter(([method]) => method === 'device.certificate')).toHaveLength(
        1
      )
    )
    await f.settled('offline', 'p2p.certificate_recovery_required')
    expect(f.remembered).toHaveBeenLastCalledWith(serviceId, user.userId)
    expect(f.legacy.replace).not.toHaveBeenCalled()
    await expect(f.owner.currentUser(serviceId, new AbortController().signal)).resolves.toEqual(
      user
    )
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('user.logout')
  })

  it('does not schedule recovery after manual selection persistence fails', async () => {
    const f = enrolledLegacy()
    await f.login()
    await f.settled('offline', 'p2p.certificate_recovery_required')
    f.call.mockClear()
    f.remember.mockRejectedValueOnce(new PeerHelperError('p2p.certificate_sync_failed'))
    await expect(
      f.owner.rememberAccountSelection(serviceId, user.userId, recoveryNetworkId)
    ).rejects.toMatchObject({ code: 'p2p.certificate_sync_failed' })
    expect(f.call).not.toHaveBeenCalled()
    expect(f.legacy.replace).not.toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('does not resume recovery when shutdown completes during manual selection persistence', async () => {
    const f = enrolledLegacy()
    await f.login()
    await f.settled('offline', 'p2p.certificate_recovery_required')
    f.call.mockClear()
    const original = f.remember.getMockImplementation()!
    let release!: () => void
    f.remember.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(...args)
    })
    const pending = f.owner.rememberAccountSelection(serviceId, user.userId, recoveryNetworkId)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.owner.close()
    release()
    await pending
    await Promise.resolve()
    expect(f.call).not.toHaveBeenCalled()
    expect(f.legacy.replace).not.toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })
})
