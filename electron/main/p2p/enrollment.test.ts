import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PeerCredential, PeerRegistrationReadback } from './credentials'
import type { PeerPendingEnrollment } from './enrollment-record'
import { PeerEnrollment } from './enrollment'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(64)
const networkId = 'b'.repeat(32)
const user = { userId: 'c'.repeat(32), username: 'owner' }
const signal = () => new AbortController().signal

function fixture() {
  const key = generateKeyPairSync('ed25519')
  const publicKey = key.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64')
  const privateKey = Buffer.concat([
    key.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    Buffer.from(publicKey, 'base64')
  ]).toString('base64')
  const device = {
    deviceId: 'd'.repeat(32),
    userId: user.userId,
    name: 'Work computer',
    publicKey,
    certificate: Buffer.from('unit-test-public-certificate').toString('base64')
  }
  const service = {
    serviceId,
    displayName: 'Server',
    httpsOrigin: 'https://example.test',
    wssUrl: 'wss://example.test/v1/signals',
    stunAddress: 'example.test:3478',
    publicKey,
    certificate: device.certificate
  }
  const order: string[] = []
  let saved: PeerRegistrationReadback | undefined
  const prepareEnrollment = vi.fn(async (enrollment: PeerPendingEnrollment) => {
    order.push('persist-pending')
    if (saved) throw new PeerHelperError('p2p.credential_write_failed')
    saved = { kind: 'pending', revision: '1'.repeat(64), enrollment: { ...enrollment } }
    return { revision: saved.revision, enrollment: { ...enrollment } }
  })
  const completeEnrollment = vi.fn(async (credential: PeerCredential, revision: string) => {
    order.push('persist-issued')
    if (!saved || saved.revision !== revision) throw new PeerHelperError('p2p.credential_conflict')
    saved = { kind: 'registered', revision: '2'.repeat(64), credential: { ...credential } }
    return { revision: saved.revision, credential: { ...credential } }
  })
  const loadRegistration = vi.fn(async () => {
    if (!saved) throw new PeerHelperError('p2p.credential_unavailable')
    return structuredClone(saved)
  })
  const remove = vi.fn(async (_serviceId: string, revision: string) => {
    order.push('credential-removed')
    if (!saved || saved.revision !== revision) throw new PeerHelperError('p2p.credential_conflict')
    saved = undefined
  })
  const accounts = {
    currentUser: vi.fn(async () => user),
    sessionToken: vi.fn(() => 'd'.repeat(64) as string | undefined),
    enrollmentGrant: vi.fn(async () => {
      order.push('grant')
      return { token: 'e'.repeat(64), networkId, expiresAt: Math.floor(Date.now() / 1000) + 300 }
    })
  }
  const services = {
    activate: vi.fn(async () => service),
    requireSaved: vi.fn(async () => service)
  }
  const call = vi.fn(
    async (method: string, _payload: unknown, _signal: AbortSignal): Promise<unknown> => {
      order.push(method)
      if (method === 'device.createKey')
        return { privateKey, csr: '-----BEGIN CERTIFICATE REQUEST-----\ntest' }
      if (method === 'device.createCSR') return { csr: '-----BEGIN CERTIFICATE REQUEST-----\ntest' }
      if (method === 'device.enroll' || method === 'device.enrollmentResult') return { ...device }
      if (method === 'network.join') return { ...device }
      if (method === 'network.leave') return {}
      throw new PeerHelperError('p2p.invalid_operation')
    }
  )
  const enrollment = new PeerEnrollment({
    accounts,
    services,
    rpc: { call },
    credentials: { prepareEnrollment, completeEnrollment, loadRegistration, remove }
  })
  const prepare = async () => {
    await prepareEnrollment({
      serviceId,
      networkId,
      userId: user.userId,
      requestId: 'f'.repeat(32),
      name: device.name,
      publicKey,
      privateKey
    })
    order.length = 0
  }
  return {
    enrollment,
    accounts,
    services,
    call,
    prepareEnrollment,
    completeEnrollment,
    loadRegistration,
    order,
    device,
    privateKey,
    prepare
  }
}

describe('main enrollment orchestration (test-only dependency doubles)', () => {
  it('joins by networkId without a session and takes the owner the server assigns', async () => {
    const f = fixture()
    const result = await f.enrollment.join(serviceId, networkId, f.device.name, signal())
    expect(result).toMatchObject({ kind: 'registered', deviceId: f.device.deviceId })
    // No session is read: possession of the networkId is the whole claim.
    expect(f.accounts.currentUser).not.toHaveBeenCalled()
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
    // The key is persisted before the join and the result is read back before
    // it is committed, so an interrupted join cannot leave a phantom device.
    expect(f.order).toEqual([
      'device.createKey',
      'network.join',
      'persist-pending',
      'device.enrollmentResult',
      'persist-issued'
    ])
  })

  it('refuses a join whose reply describes a different device', async () => {
    const f = fixture()
    f.call.mockImplementation(async (method: string) => {
      if (method === 'device.createKey')
        return { privateKey: f.privateKey, csr: '-----BEGIN CERTIFICATE REQUEST-----\ntest' }
      // A reply naming another public key must never become a local credential.
      if (method === 'network.join') return { ...f.device, publicKey: 'A'.repeat(43) + '=' }
      throw new PeerHelperError('p2p.invalid_operation')
    })
    await expect(
      f.enrollment.join(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.identity_mismatch' })
    await expect(f.loadRegistration()).rejects.toMatchObject({
      code: 'p2p.credential_unavailable'
    })
  })

  it('requires a session to leave and clears the credential only after the server confirms', async () => {
    const f = fixture()
    await f.enrollment.join(serviceId, networkId, f.device.name, signal())
    f.order.length = 0

    // Without a session the coordinator has no login-free removal to call.
    f.accounts.sessionToken.mockReturnValueOnce(undefined)
    await expect(
      f.enrollment.leave(serviceId, networkId, f.device.deviceId, signal())
    ).rejects.toMatchObject({ code: 'p2p.user_login_required' })
    expect(f.order).toEqual([])

    await f.enrollment.leave(serviceId, networkId, f.device.deviceId, signal())
    // The server confirms first; only then is the local credential dropped.
    expect(f.order).toEqual(['network.leave', 'credential-removed'])
    await expect(f.loadRegistration()).rejects.toMatchObject({
      code: 'p2p.credential_unavailable'
    })
  })

  it('keeps the credential when the server refuses the removal', async () => {
    const f = fixture()
    await f.enrollment.join(serviceId, networkId, f.device.name, signal())
    f.order.length = 0
    // Refuse the removal specifically, not whatever call happens to come first.
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method: string, payload: unknown, sig: AbortSignal) => {
      if (method === 'network.leave') {
        f.order.push(method)
        throw new PeerHelperError('p2p.network_unauthorized')
      }
      return original(method, payload, sig)
    })
    await expect(
      f.enrollment.leave(serviceId, networkId, f.device.deviceId, signal())
    ).rejects.toMatchObject({ code: 'p2p.network_unauthorized' })
    // A refused removal must not strand the device without its credential.
    expect(f.order).toEqual(['network.leave'])
    expect(await f.loadRegistration()).toMatchObject({ kind: 'registered' })
  })

  it('refuses to leave on behalf of a device that is not the one stored here', async () => {
    const f = fixture()
    await f.enrollment.join(serviceId, networkId, f.device.name, signal())
    f.order.length = 0
    await expect(
      f.enrollment.leave(serviceId, networkId, 'a'.repeat(32), signal())
    ).rejects.toMatchObject({ code: 'p2p.device_unregistered' })
    expect(f.order).toEqual([])
  })

  it('persists the original identity before a grant, verifies server readback, then commits', async () => {
    const f = fixture()
    const result = await f.enrollment.register(serviceId, networkId, f.device.name, signal())
    expect(f.order).toEqual([
      'device.createKey',
      'persist-pending',
      'device.createCSR',
      'grant',
      'device.enroll',
      'device.enrollmentResult',
      'persist-issued'
    ])
    const pending = f.prepareEnrollment.mock.calls[0][0]
    expect(pending).toMatchObject({
      serviceId,
      networkId,
      userId: user.userId,
      publicKey: f.device.publicKey,
      privateKey: f.privateKey
    })
    expect(pending.requestId).toMatch(/^[a-f0-9]{32}$/)
    expect(f.accounts.enrollmentGrant).toHaveBeenCalledWith(
      serviceId,
      networkId,
      user.userId,
      expect.any(AbortSignal)
    )
    expect(f.call.mock.calls.find(([method]) => method === 'device.enrollmentResult')?.[1]).toEqual(
      { serviceId, data: { requestId: pending.requestId, privateKey: f.privateKey } }
    )
    expect(result).toEqual({
      kind: 'registered',
      serviceId,
      deviceId: f.device.deviceId,
      userId: user.userId,
      name: f.device.name,
      publicKey: f.device.publicKey,
      revision: '2'.repeat(64)
    })
    expect(JSON.stringify(result)).not.toContain(f.privateKey)
    expect(JSON.stringify(result)).not.toContain('certificate')
  })

  it('does not request a grant if encrypted pending persistence fails', async () => {
    const f = fixture()
    f.prepareEnrollment.mockRejectedValueOnce(new PeerHelperError('p2p.secure_storage_unavailable'))
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.secure_storage_unavailable' })
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['device.createKey'])
  })

  it('retains pending state after an ambiguous write and never automatically re-enrolls', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (...args) => {
      if (args[0] === 'device.enroll') throw new PeerHelperError('p2p.server_unavailable')
      return original(...args)
    })
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.server_unavailable' })
    const pending = await f.enrollment.inspect(serviceId, signal())
    expect(pending.kind).toBe('pending')
    expect(JSON.stringify(pending)).not.toContain(f.privateKey)
    expect(f.completeEnrollment).not.toHaveBeenCalled()
    expect(f.call.mock.calls.filter(([method]) => method === 'device.enroll')).toHaveLength(1)
    f.call.mockClear()
    f.accounts.enrollmentGrant.mockClear()
    await f.enrollment.recover(serviceId, pending.revision, signal())
    expect(f.call.mock.calls.map(([method]) => method)).toEqual(['device.enrollmentResult'])
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
  })

  it('reports a missing query result without consuming a new grant or replacing the key', async () => {
    const f = fixture()
    await f.prepare()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.enrollment_not_found'))
    await expect(f.enrollment.recover(serviceId, '1'.repeat(64), signal())).rejects.toMatchObject({
      code: 'p2p.enrollment_not_found'
    })
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
    expect(f.completeEnrollment).not.toHaveBeenCalled()
    expect((await f.enrollment.inspect(serviceId, signal())).kind).toBe('pending')
  })

  it('explicit submission reuses the persisted request and key, never createKey', async () => {
    const f = fixture()
    await f.prepare()
    await f.enrollment.submitPending(serviceId, '1'.repeat(64), signal())
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.createCSR',
      'device.enroll',
      'device.enrollmentResult'
    ])
    expect(f.call.mock.calls[0][1]).toEqual({ privateKey: f.privateKey })
    expect(f.call.mock.calls[1][1]).toMatchObject({
      serviceId,
      data: { requestId: 'f'.repeat(32), name: f.device.name }
    })
  })

  it('rejects stale revisions and changed users before key or network writes', async () => {
    const f = fixture()
    await f.prepare()
    await expect(
      f.enrollment.submitPending(serviceId, '0'.repeat(64), signal())
    ).rejects.toMatchObject({ code: 'p2p.credential_conflict' })
    f.accounts.currentUser.mockResolvedValueOnce({ ...user, userId: '9'.repeat(32) })
    await expect(f.enrollment.recover(serviceId, '1'.repeat(64), signal())).rejects.toMatchObject({
      code: 'p2p.user_scope_mismatch'
    })
    expect(f.call).not.toHaveBeenCalled()
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
  })

  it.each(['userId', 'name', 'publicKey', 'deviceId', 'certificate', 'extra'])(
    'rejects an invalid result field %s before local completion',
    async (field) => {
      const f = fixture()
      await f.prepare()
      f.call.mockResolvedValueOnce({ ...f.device, [field]: 'invalid' })
      await expect(f.enrollment.recover(serviceId, '1'.repeat(64), signal())).rejects.toThrow()
      expect(f.completeEnrollment).not.toHaveBeenCalled()
    }
  )

  it('does not accept a different query identity after the initial enrollment response', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (...args) =>
      args[0] === 'device.enrollmentResult'
        ? { ...f.device, deviceId: '9'.repeat(32) }
        : original(...args)
    )
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.enrollment_result_unconfirmed' })
    expect(f.completeEnrollment).not.toHaveBeenCalled()
  })

  it('rejects forgotten services, cancellation and closure before operations', async () => {
    const f = fixture()
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, AbortSignal.abort())
    ).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    f.services.requireSaved.mockRejectedValueOnce(new PeerHelperError('p2p.trust_restore_rejected'))
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.trust_restore_rejected' })
    f.enrollment.close()
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('locks one service while a key response is pending and rejects that response after close', async () => {
    const f = fixture()
    let release!: (value: unknown) => void
    f.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = f.enrollment.register(serviceId, networkId, f.device.name, signal())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1))
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, signal())
    ).rejects.toMatchObject({ code: 'p2p.service_busy' })
    f.enrollment.close()
    release({ privateKey: f.privateKey, csr: '-----BEGIN CERTIFICATE REQUEST-----\ntest' })
    await rejected
    expect(f.prepareEnrollment).not.toHaveBeenCalled()
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
  })

  it('keeps durable pending identity if cancellation happens during persistence', async () => {
    const f = fixture()
    const abort = new AbortController()
    const save = f.prepareEnrollment.getMockImplementation()!
    f.prepareEnrollment.mockImplementationOnce(async (pending) => {
      const saved = await save(pending)
      abort.abort()
      return saved
    })
    await expect(
      f.enrollment.register(serviceId, networkId, f.device.name, abort.signal)
    ).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.accounts.enrollmentGrant).not.toHaveBeenCalled()
    expect((await f.enrollment.inspect(serviceId, signal())).kind).toBe('pending')
  })

  it('reports a wrong persistent readback as unconfirmed instead of returning its identity', async () => {
    const f = fixture()
    await f.prepare()
    f.completeEnrollment.mockImplementationOnce(async (credential) => ({
      revision: '2'.repeat(64),
      credential: { ...credential, deviceId: '9'.repeat(32) }
    }))
    await expect(f.enrollment.recover(serviceId, '1'.repeat(64), signal())).rejects.toMatchObject({
      code: 'p2p.enrollment_result_unconfirmed'
    })
  })
})
