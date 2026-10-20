import { describe, expect, it, vi } from 'vitest'
import { PeerHelperError } from './wire'
import {
  legacyCertificateFixture,
  legacyCredential,
  recoveryNetworkId,
  recoveryUser,
  recoveryToken,
  recoveredCertificate
} from './tests/legacy-certificate-fixture'

const certificateCalls = (f: ReturnType<typeof legacyCertificateFixture>) =>
  f.call.mock.calls.filter(([method]) => method === 'device.certificate')

describe('legacy certificate session recovery', () => {
  it('recovers the exact verified manual scope while preserving every legacy identity field', async () => {
    const f = legacyCertificateFixture()
    await f.ready()
    const calls = certificateCalls(f)
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).not.toHaveProperty('data.networkId')
    expect(calls[1][1]).toEqual({
      serviceId: legacyCredential.serviceId,
      data: {
        device: {
          deviceId: legacyCredential.deviceId,
          userId: legacyCredential.userId,
          name: legacyCredential.name,
          publicKey: legacyCredential.publicKey,
          certificate: legacyCredential.certificate
        },
        privateKey: legacyCredential.privateKey,
        token: recoveryToken,
        networkId: recoveryNetworkId
      }
    })
    expect(f.stored().credential).toEqual({
      ...legacyCredential,
      certificate: recoveredCertificate
    })
    expect(f.stored().credential).not.toHaveProperty('networkId')
    expect(f.remembered).toHaveBeenCalledWith(legacyCredential.serviceId, recoveryUser.userId)
    expect(f.load).toHaveBeenCalledTimes(2)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.certificate',
      'device.restore'
    ])
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('device.enroll')
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('runtime.start')
  })

  it('shares one scoped recovery and storage flight across concurrent requests', async () => {
    const f = legacyCertificateFixture()
    const first = f.ready()
    const second = f.ready()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(certificateCalls(f)).toHaveLength(2)
    expect(f.accounts.certificateRecoveryScope).toHaveBeenCalledOnce()
    expect(f.accounts.currentUser).not.toHaveBeenCalled()
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.replace).toHaveBeenCalledOnce()
  })

  it('never consults selection when the first canonical certificate request succeeds', async () => {
    const f = legacyCertificateFixture()
    f.setCanonical(legacyCredential.certificate)
    f.remembered.mockResolvedValue(undefined)
    await f.ready()
    expect(certificateCalls(f)).toHaveLength(1)
    expect(f.remembered).not.toHaveBeenCalled()
    expect(f.accounts.currentUser).not.toHaveBeenCalled()
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.accounts.certificateRecoveryScope).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.stored().credential).toEqual(legacyCredential)
  })

  it('does not replace an already recorded recovery network with a manual selection', async () => {
    const f = legacyCertificateFixture({ ...legacyCredential, networkId: '1'.repeat(12) })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(certificateCalls(f)).toHaveLength(1)
    expect(f.remembered).not.toHaveBeenCalled()
    expect(f.replace).not.toHaveBeenCalled()
  })

  it.each([
    'p2p.certificate_recovery_forbidden',
    'p2p.certificate_sync_failed',
    'p2p.invalid_device_certificate',
    'p2p.server_unavailable'
  ])('does not enter legacy migration after %s', async (code) => {
    const f = legacyCertificateFixture()
    f.call.mockRejectedValueOnce(new PeerHelperError(code))
    await expect(f.ready()).rejects.toMatchObject({ code })
    expect(f.remembered).not.toHaveBeenCalled()
    expect(certificateCalls(f)).toHaveLength(1)
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('requires the exact helper error type before admitting legacy migration', async () => {
    const f = legacyCertificateFixture()
    const refusal = Object.assign(new Error('test-only non-helper refusal'), {
      code: 'p2p.certificate_recovery_required'
    })
    f.call.mockRejectedValueOnce(refusal)
    await expect(f.ready()).rejects.toBe(refusal)
    expect(f.remembered).not.toHaveBeenCalled()
    expect(certificateCalls(f)).toHaveLength(1)
  })

  it('does not resolve scope without a current valid login', async () => {
    const f = legacyCertificateFixture()
    f.accounts.hasSession.mockReturnValue(false)
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(f.remembered).not.toHaveBeenCalled()
    expect(certificateCalls(f)[0][1]).not.toHaveProperty('data.token')
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('preserves the login and identity when no manual selection exists', async () => {
    const f = legacyCertificateFixture()
    f.remembered.mockResolvedValue(undefined)
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(f.stored().credential).toEqual(legacyCredential)
    expect(f.accounts.hasSession()).toBe(true)
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.accounts.certificateRecoveryScope).toHaveBeenCalledOnce()
    expect(certificateCalls(f)).toHaveLength(1)
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('device.enroll')
  })

  it.each(['token', 'logout'] as const)(
    'does not enter the resolver after %s changes during the initial core request',
    async (change) => {
      const f = legacyCertificateFixture()
      const resolve = vi.spyOn(f.scope, 'resolve')
      f.call.mockImplementationOnce(async () => {
        if (change === 'token') f.accounts.sessionToken.mockReturnValue('1'.repeat(64))
        if (change === 'logout') f.accounts.hasSession.mockReturnValue(false)
        throw new PeerHelperError('p2p.certificate_recovery_required')
      })
      await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
      expect(resolve).not.toHaveBeenCalled()
      expect(f.accounts.currentUser).not.toHaveBeenCalled()
      expect(f.remembered).not.toHaveBeenCalled()
      expect(f.replace).not.toHaveBeenCalled()
    }
  )

  it('retains a valid login after the selected network refuses the original device', async () => {
    const f = legacyCertificateFixture()
    f.directory.networks[0].devices = []
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_forbidden' })
    expect(f.accounts.hasSession()).toBe(true)
    expect(f.stored().credential).toEqual(legacyCredential)
    expect(certificateCalls(f)).toHaveLength(1)
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('user.logout')
  })

  it('does not loop or change credentials after the single scoped request is refused', async () => {
    const f = legacyCertificateFixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, payload, signal) => {
      if (
        method === 'device.certificate' &&
        (payload as { data: { networkId?: string } }).data.networkId
      )
        throw new PeerHelperError('p2p.certificate_recovery_forbidden')
      return original(method, payload, signal)
    })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_forbidden' })
    expect(certificateCalls(f)).toHaveLength(2)
    expect(f.stored().credential).toEqual(legacyCredential)
    expect(f.accounts.hasSession()).toBe(true)
  })

  it('reads canonical partial success after desktop storage failure and restart without another scope', async () => {
    const f = legacyCertificateFixture()
    f.replace.mockRejectedValueOnce(new PeerHelperError('p2p.credential_write_failed'))
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_write_failed' })
    expect(f.canonical()).toBe(recoveredCertificate)
    expect(f.stored().credential).toEqual(legacyCredential)
    f.remembered.mockClear().mockResolvedValue(undefined)
    const restarted = f.createOwner()
    await restarted.ready(
      legacyCredential.serviceId,
      f.session,
      new AbortController().signal,
      f.reportedAccount
    )
    expect(f.remembered).not.toHaveBeenCalled()
    expect(certificateCalls(f)).toHaveLength(3)
    expect(f.stored().credential).toEqual({
      ...legacyCredential,
      certificate: recoveredCertificate
    })
    expect(f.stored().credential).not.toHaveProperty('networkId')
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
  })

  it.each(['abort', 'forget', 'clear'] as const)(
    'cancels fresh legacy verification after %s before scoped issuance',
    async (action) => {
      const f = legacyCertificateFixture()
      const controller = new AbortController()
      let release!: () => void
      f.accounts.certificateRecoveryScope.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { user: { ...recoveryUser }, networks: structuredClone(f.directory.networks) }
      })
      const pending = f.ready(controller.signal)
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      if (action === 'abort') controller.abort()
      if (action === 'forget') f.owner.forget(legacyCredential.serviceId)
      if (action === 'clear') f.owner.clear()
      release()
      await expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
      expect(certificateCalls(f)).toHaveLength(1)
      expect(f.replace).not.toHaveBeenCalled()
    }
  )

  it.each(['token', 'selection'] as const)(
    'does not persist a scoped result after %s changes during issuance',
    async (change) => {
      const f = legacyCertificateFixture()
      const original = f.call.getMockImplementation()!
      f.call.mockImplementation(async (method, payload, signal) => {
        const result = await original(method, payload, signal)
        if (
          method === 'device.certificate' &&
          (payload as { data: { networkId?: string } }).data.networkId
        ) {
          if (change === 'token') f.accounts.sessionToken.mockReturnValue('1'.repeat(64))
          if (change === 'selection') f.remembered.mockResolvedValue('2'.repeat(12))
        }
        return result
      })
      await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
      expect(f.canonical()).toBe(recoveredCertificate)
      expect(f.replace).not.toHaveBeenCalled()
      expect(f.stored().credential).toEqual(legacyCredential)
    }
  )

  it('rejects a stale legacy credential revision without persisting a recovery result', async () => {
    const f = legacyCertificateFixture()
    f.replace.mockRejectedValueOnce(new PeerHelperError('p2p.credential_conflict'))
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_conflict' })
    expect(f.stored().credential).toEqual(legacyCredential)
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(0)
  })

  it('cancels a queued certificate write when an explicit selection replaces its scope', async () => {
    const f = legacyCertificateFixture()
    const original = f.replace.getMockImplementation()!
    let release!: () => void
    f.replace.mockImplementationOnce(async (credential, revision, assertCurrent) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original(credential, revision, assertCurrent)
    })
    const pending = f.ready()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.scope.selectionChanged(legacyCredential.serviceId)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.stored().credential).toEqual(legacyCredential)
  })
})
