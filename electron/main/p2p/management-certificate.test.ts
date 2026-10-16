import { describe, expect, it, vi } from 'vitest'
import { PeerCredentialStore, type PeerCredential } from './credentials'
import { PeerHelperError } from './wire'
import { fixture, serviceId, networkId, user } from './tests/management-fixture'

vi.mock('electron', () => ({ safeStorage: {} }))

function enrolled() {
  let stored = {
    revision: '1'.repeat(64),
    credential: {
      serviceId,
      deviceId: '3'.repeat(12),
      userId: user.userId,
      name: 'This machine',
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      privateKey: Buffer.alloc(64, 9).toString('base64'),
      certificate: Buffer.from('original certificate').toString('base64'),
      networkId
    }
  }
  vi.spyOn(PeerCredentialStore.prototype, 'load').mockImplementation(async () =>
    structuredClone(stored)
  )
  vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockImplementation(async () => ({
    kind: 'registered' as const,
    ...structuredClone(stored)
  }))
  const replace = vi
    .spyOn(PeerCredentialStore.prototype, 'replace')
    .mockImplementation(async (credential: PeerCredential, revision, assertCurrent) => {
      assertCurrent?.()
      expect(revision).toBe(stored.revision)
      stored = { revision: '2'.repeat(64), credential: { ...stored.credential, ...credential } }
      return structuredClone(stored)
    })
  return { replace, stored: () => structuredClone(stored) }
}

describe('device certificate management integration', () => {
  it('starts restoration after successful login independently of the login request lifetime', async () => {
    const f = fixture()
    const saved = enrolled()
    const original = f.call.getMockImplementation()!
    let release!: () => void
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.certificate') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return original(method, payload, active)
    })
    const request = new AbortController()
    await expect(
      f.owner.login(serviceId, user.username, 'test-password', request.signal)
    ).resolves.toEqual(user)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    request.abort()
    expect(f.call.mock.calls.some(([method]) => method === 'device.restore')).toBe(false)
    release()
    await vi.waitFor(async () =>
      expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'online', code: '' }])
    )
    const certificateRequest = f.call.mock.calls.find(
      ([method]) => method === 'device.certificate'
    )!
    expect(certificateRequest[1]).toMatchObject({
      serviceId,
      data: { networkId, token: '8'.repeat(64), privateKey: saved.stored().credential.privateKey }
    })
    expect(certificateRequest[2].aborted).toBe(false)
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('retains a valid login when its account lacks certificate recovery authority', async () => {
    const f = fixture()
    enrolled()
    const removeSession = vi.spyOn(PeerCredentialStore.prototype, 'removeUserSession')
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.certificate')
        throw new PeerHelperError('p2p.certificate_recovery_forbidden')
      return original(method, payload, active)
    })
    await expect(
      f.owner.login(serviceId, user.username, 'test-password', new AbortController().signal)
    ).resolves.toEqual(user)
    await vi.waitFor(async () =>
      expect(await f.owner.serviceSessions()).toEqual([
        { serviceId, state: 'offline', code: 'p2p.certificate_recovery_forbidden' }
      ])
    )
    await expect(f.owner.currentUser(serviceId, new AbortController().signal)).resolves.toEqual(
      user
    )
    expect(removeSession).not.toHaveBeenCalled()
    expect(f.call.mock.calls.map(([method]) => method)).not.toContain('user.logout')
  })

  it('retries with the new login after an overlapping unauthorized startup attempt settles', async () => {
    const f = fixture()
    enrolled()
    const original = f.call.getMockImplementation()!
    let reject!: (error: Error) => void
    let requests = 0
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.certificate' && ++requests === 1)
        return new Promise((_resolve, fail) => {
          reject = fail
        })
      return original(method, payload, active)
    })
    const startup = f.owner.goOnline()
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    await expect(
      f.owner.login(serviceId, user.username, 'test-password', new AbortController().signal)
    ).resolves.toEqual(user)
    reject(new PeerHelperError('p2p.certificate_recovery_required'))
    await startup
    await vi.waitFor(async () =>
      expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'online', code: '' }])
    )
    const certificateRequests = f.call.mock.calls.filter(
      ([method]) => method === 'device.certificate'
    )
    expect(certificateRequests).toHaveLength(2)
    expect(certificateRequests[0][1]).not.toHaveProperty('data.token')
    expect(certificateRequests[1][1]).toHaveProperty('data.token', '8'.repeat(64))
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
  })

  it('synchronizes an online service on connectivity maintenance without another restore', async () => {
    const f = fixture()
    const saved = enrolled()
    await expect(f.owner.goOnline()).resolves.toEqual([{ serviceId, online: true }])
    const original = f.call.getMockImplementation()!
    const certificate = Buffer.from('canonical renewed certificate').toString('base64')
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.certificate') {
        const { deviceId, publicKey } = saved.stored().credential
        return { deviceId, publicKey, certificate }
      }
      return original(method, payload, active)
    })
    f.owner.resumeConnectivity()
    await vi.waitFor(() => expect(saved.replace).toHaveBeenCalledOnce())
    expect(saved.stored().credential.certificate).toBe(certificate)
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it.each(['close', 'remove'] as const)(
    'never writes a certificate response arriving after %s',
    async (action) => {
      const f = fixture()
      const saved = enrolled()
      let release!: (value: unknown) => void
      const original = f.call.getMockImplementation()!
      f.call.mockImplementation(async (method, payload, active) => {
        if (method === 'device.certificate')
          return new Promise((resolve) => {
            release = resolve
          })
        return original(method, payload, active)
      })
      const online = f.owner.goOnline()
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      if (action === 'close') await f.owner.close()
      if (action === 'remove') await f.owner.removeService(serviceId, new AbortController().signal)
      const { deviceId, publicKey } = saved.stored().credential
      release({
        deviceId,
        publicKey,
        certificate: Buffer.from('late certificate').toString('base64')
      })
      await expect(online).resolves.toEqual([
        { serviceId, online: false, code: 'p2p.request_cancelled' }
      ])
      expect(saved.replace).not.toHaveBeenCalled()
      expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(0)
    }
  )
})
