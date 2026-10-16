import { describe, expect, it, vi } from 'vitest'
import type { PeerCredential } from './credentials'
import { PeerDeviceSession } from './device-session'
import { PeerHelperError } from './wire'

const credential: PeerCredential = {
  serviceId: 'a'.repeat(12),
  deviceId: 'b'.repeat(12),
  userId: 'c'.repeat(12),
  name: 'Original computer',
  publicKey: Buffer.alloc(32, 1).toString('base64'),
  privateKey: Buffer.alloc(64, 2).toString('base64'),
  certificate: Buffer.from('original certificate').toString('base64'),
  networkId: 'd'.repeat(12)
}
const newerCertificate = Buffer.from('renewed certificate').toString('base64')
const signal = () => new AbortController().signal

function fixture() {
  let stored = { revision: '1'.repeat(64), credential: { ...credential } }
  const load = vi.fn(async () => structuredClone(stored))
  const replace = vi.fn(async (value: PeerCredential, _revision: string) => {
    stored = { revision: '2'.repeat(64), credential: { ...value } }
    return structuredClone(stored)
  })
  const reply = {
    deviceId: credential.deviceId,
    publicKey: credential.publicKey,
    certificate: newerCertificate
  }
  const call = vi.fn(
    async (method: string, _payload: unknown, _signal: AbortSignal): Promise<unknown> => {
      if (method === 'device.certificate') return { ...reply }
      if (method === 'device.restore') return { deviceId: credential.deviceId }
      throw new PeerHelperError('p2p.invalid_operation')
    }
  )
  const accounts = {
    hasSession: vi.fn(() => true),
    sessionToken: vi.fn((): string | undefined => 'e'.repeat(64))
  }
  const owner = new PeerDeviceSession({ load, replace })
  const reportedAccount = vi.fn(async () => 'f'.repeat(12))
  const ready = (active = signal(), maintain: boolean | 'after-login' = false) =>
    owner.ready(
      credential.serviceId,
      { rpc: { call }, accounts },
      active,
      reportedAccount,
      maintain
    )
  return {
    owner,
    ready,
    load,
    replace,
    reply,
    call,
    accounts,
    reportedAccount,
    stored: () => structuredClone(stored)
  }
}

describe('device certificate synchronization', () => {
  it('changes only the certificate, reads it back and restores the original device with separate presence', async () => {
    const f = fixture()
    await f.ready()
    expect(f.replace).toHaveBeenCalledWith(
      { ...credential, certificate: newerCertificate },
      '1'.repeat(64),
      expect.any(Function)
    )
    expect(f.load).toHaveBeenCalledTimes(2)
    expect(f.stored().credential).toEqual({ ...credential, certificate: newerCertificate })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.restore'
    ])
    expect(f.call.mock.calls[0][1]).toEqual({
      serviceId: credential.serviceId,
      data: {
        device: {
          deviceId: credential.deviceId,
          userId: credential.userId,
          name: credential.name,
          publicKey: credential.publicKey,
          certificate: credential.certificate
        },
        privateKey: credential.privateKey,
        networkId: credential.networkId,
        token: 'e'.repeat(64)
      }
    })
    expect(f.call.mock.calls[1][1]).toMatchObject({
      data: {
        device: {
          deviceId: credential.deviceId,
          userId: 'f'.repeat(12),
          publicKey: credential.publicKey,
          certificate: newerCertificate
        },
        privateKey: credential.privateKey,
        pins: []
      }
    })
  })

  it('does not rewrite an unchanged certificate or recheck it on every foreground operation', async () => {
    const f = fixture()
    f.reply.certificate = credential.certificate
    await f.ready()
    await f.ready()
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.restore'
    ])
  })

  it('synchronizes a renewed canonical certificate during online maintenance without restoring again', async () => {
    const f = fixture()
    f.reply.certificate = credential.certificate
    await f.ready()
    f.reply.certificate = newerCertificate
    await f.ready(signal(), true)
    expect(f.replace).toHaveBeenCalledOnce()
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.restore',
      'device.certificate'
    ])
  })

  it('shares one per-service maintenance and storage owner across concurrent requests', async () => {
    const f = fixture()
    const first = f.ready()
    const second = f.ready()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(f.replace).toHaveBeenCalledOnce()
    expect(f.call).toHaveBeenCalledTimes(2)
  })

  it.each(['deviceId', 'publicKey'] as const)(
    'rejects a changed %s before persisting or restoring',
    async (field) => {
      const f = fixture()
      f.reply[field] = 'foreign identity'
      await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.identity_mismatch' })
      expect(f.replace).not.toHaveBeenCalled()
      expect(f.reportedAccount).not.toHaveBeenCalled()
    }
  )

  it.each(['', 'not base64', 'Zg', 'Zm9v\n', Buffer.alloc(16 * 1024 + 1).toString('base64')])(
    'rejects malformed or oversized certificate encoding before persistence',
    async (certificate) => {
      const f = fixture()
      f.reply.certificate = certificate
      await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.invalid_device_certificate' })
      expect(f.replace).not.toHaveBeenCalled()
      expect(f.reportedAccount).not.toHaveBeenCalled()
    }
  )

  it.each([
    'certificate',
    'deviceId',
    'userId',
    'privateKey',
    'publicKey',
    'name',
    'networkId'
  ] as const)('rejects storage readback that changes %s', async (field) => {
    const f = fixture()
    f.replace.mockResolvedValueOnce({
      revision: '2'.repeat(64),
      credential: { ...credential, certificate: newerCertificate, [field]: 'wrong stored value' }
    })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_write_failed' })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['device.certificate'])
  })

  it('checks the independent durable read after replacement rather than trusting its return value', async () => {
    const f = fixture()
    f.load.mockResolvedValueOnce({ revision: '1'.repeat(64), credential: { ...credential } })
    f.load.mockResolvedValueOnce({ revision: '2'.repeat(64), credential: { ...credential } })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_write_failed' })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['device.certificate'])
  })

  it('rejects a concurrent revision change after persistence', async () => {
    const f = fixture()
    f.load.mockResolvedValueOnce({ revision: '1'.repeat(64), credential: { ...credential } })
    f.load.mockResolvedValueOnce({
      revision: '3'.repeat(64),
      credential: { ...credential, certificate: newerCertificate }
    })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_conflict' })
  })

  it('retries synchronization after a failed desktop write without replacing the identity', async () => {
    const f = fixture()
    f.replace.mockRejectedValueOnce(new PeerHelperError('p2p.credential_write_failed'))
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.credential_write_failed' })
    expect(f.stored().credential).toEqual(credential)
    await f.ready()
    expect(f.stored().credential).toEqual({ ...credential, certificate: newerCertificate })
    expect(f.call.mock.calls.filter(([method]) => method === 'device.restore')).toHaveLength(1)
  })

  it.each(['abort', 'forget', 'clear'] as const)(
    'rejects a delayed certificate response after %s',
    async (action) => {
      const f = fixture()
      const controller = new AbortController()
      let release!: (value: unknown) => void
      f.call.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
      const pending = f.ready(controller.signal)
      await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce())
      if (action === 'abort') controller.abort()
      if (action === 'forget') f.owner.forget(credential.serviceId)
      if (action === 'clear') f.owner.clear()
      release({ ...f.reply })
      await expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
      expect(f.replace).not.toHaveBeenCalled()
      expect(f.stored().credential).toEqual(credential)
    }
  )

  it('preserves an actionable recovery refusal and the current login', async () => {
    const f = fixture()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.certificate_recovery_forbidden'))
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_forbidden' })
    expect(f.accounts.hasSession()).toBe(true)
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.stored().credential).toEqual(credential)
  })

  it('cancels login maintenance queued behind a forgotten service', async () => {
    const f = fixture()
    let release!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const original = f.ready()
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce())
    const afterLogin = f.ready(signal(), 'after-login')
    f.owner.forget(credential.serviceId)
    release({ ...f.reply })
    await expect(original).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    await expect(afterLogin).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.call).toHaveBeenCalledOnce()
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('never infers a missing network or sends a stale login token', async () => {
    const f = fixture()
    const { networkId: _networkId, ...legacy } = credential
    f.load.mockResolvedValue({ revision: '1'.repeat(64), credential: legacy })
    f.reply.certificate = credential.certificate
    f.accounts.hasSession.mockReturnValue(false)
    await f.ready()
    const data = (f.call.mock.calls[0][1] as { data: object }).data
    expect(data).not.toHaveProperty('networkId')
    expect(data).not.toHaveProperty('token')
    expect(f.accounts.sessionToken).not.toHaveBeenCalled()
  })

  it('does not classify unreadable credentials as an unregistered device', async () => {
    const f = fixture()
    f.load.mockRejectedValueOnce(new PeerHelperError('p2p.secret_provider_unavailable'))
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.secret_provider_unavailable' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('checks restore identity and propagates invalid state instead of treating it as restored', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.restore') throw new PeerHelperError('p2p.invalid_device_state')
      return original(method, payload, active)
    })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.invalid_device_state' })
    f.call.mockImplementation(async (method, payload, active) => {
      if (method === 'device.restore') return { deviceId: '0'.repeat(12) }
      return original(method, payload, active)
    })
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.identity_mismatch' })
  })
})
