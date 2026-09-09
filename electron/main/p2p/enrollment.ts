import { randomBytes } from 'node:crypto'
import type { PeerAccounts } from './accounts'
import { assertAccountId, assertAccountText } from './account-records'
import type {
  PeerCredential,
  PeerCredentialStore,
  PeerPendingEnrollmentReadback
} from './credentials'
import { assertPendingEnrollment, type PeerPendingEnrollment } from './enrollment-record'
import type { PeerRpc } from './rpc'
import type { PeerServices } from './services'
import { exactPeerObject, PeerHelperError } from './wire'

export type PeerRegistrationView =
  | {
      kind: 'pending'
      serviceId: string
      requestId: string
      networkId: string
      userId: string
      name: string
      publicKey: string
      revision: string
    }
  | {
      kind: 'registered'
      serviceId: string
      deviceId: string
      userId: string
      name: string
      publicKey: string
      revision: string
    }

interface Dependencies {
  services: Pick<PeerServices, 'activate' | 'requireSaved'>
  accounts: Pick<PeerAccounts, 'currentUser' | 'enrollmentGrant' | 'sessionToken'>
  credentials: Pick<
    PeerCredentialStore,
    'prepareEnrollment' | 'completeEnrollment' | 'loadRegistration' | 'remove'
  >
  rpc: Pick<PeerRpc, 'call'>
}

/** Main owns all secret handling and durable ordering of the enrollment workflow. */
export class PeerEnrollment {
  readonly #lifetime = new AbortController()
  readonly #busy = new Set<string>()
  constructor(private readonly dependencies: Dependencies) {}

  close(): void {
    this.#lifetime.abort()
  }

  inspect(serviceId: string, signal: AbortSignal): Promise<PeerRegistrationView> {
    return this.#operation(serviceId, signal, async (operationSignal) => {
      const saved = await this.dependencies.credentials.loadRegistration(serviceId)
      this.#admit(operationSignal)
      if (saved.kind === 'registered') return registeredView(saved.credential, saved.revision)
      const { serviceId: id, requestId, networkId, userId, name, publicKey } = saved.enrollment
      return {
        kind: 'pending',
        serviceId: id,
        requestId,
        networkId,
        userId,
        name,
        publicKey,
        revision: saved.revision
      }
    })
  }

  register(
    serviceId: string,
    networkId: string,
    name: string,
    signal: AbortSignal
  ): Promise<PeerRegistrationView> {
    assertAccountId(networkId)
    assertAccountText(name)
    return this.#operation(serviceId, signal, async (operationSignal) => {
      await this.dependencies.services.activate(serviceId, operationSignal)
      const user = await this.dependencies.accounts.currentUser(serviceId, operationSignal)
      const created = exactPeerObject(await this.#call('device.createKey', {}, operationSignal), [
        'privateKey',
        'csr'
      ])
      const privateKey = base64(created.privateKey, 64, 64)
      const bytes = Buffer.from(privateKey, 'base64')
      const publicKey = bytes.subarray(32).toString('base64')
      bytes.fill(0)
      const pending: PeerPendingEnrollment = {
        serviceId,
        networkId,
        name,
        userId: user.userId,
        requestId: randomBytes(16).toString('hex'),
        publicKey,
        privateKey
      }
      assertPendingEnrollment(pending)
      this.#admit(operationSignal)
      // No enrollment token is requested or consumed before this durable readback.
      const saved = await this.dependencies.credentials.prepareEnrollment(pending)
      this.#admit(operationSignal)
      return this.#submit(saved, operationSignal)
    })
  }

  /**
   * Enrols this device into a network using only its networkId.
   *
   * No session is involved. Unlike register(), the owning user is not known
   * before the call: the coordinator makes the network's owner the device's
   * owner, so the identity is read from the confirmed result rather than
   * asserted beforehand. The credential is persisted only after that result is
   * independently read back, so an interrupted join never leaves a device that
   * believes it joined.
   */
  join(
    serviceId: string,
    networkId: string,
    name: string,
    signal: AbortSignal
  ): Promise<PeerRegistrationView> {
    assertAccountId(networkId)
    assertAccountText(name)
    return this.#operation(serviceId, signal, async (operationSignal) => {
      await this.dependencies.services.activate(serviceId, operationSignal)
      const created = exactPeerObject(await this.#call('device.createKey', {}, operationSignal), [
        'privateKey',
        'csr'
      ])
      const privateKey = base64(created.privateKey, 64, 64)
      const bytes = Buffer.from(privateKey, 'base64')
      const publicKey = bytes.subarray(32).toString('base64')
      bytes.fill(0)
      const requestId = randomBytes(16).toString('hex')
      const csr = created.csr
      if (
        typeof csr !== 'string' ||
        !csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----') ||
        Buffer.byteLength(csr) > 16 * 1024
      )
        throw new PeerHelperError('p2p.invalid_csr')
      this.#admit(operationSignal)
      const reply = await this.#call(
        'network.join',
        { serviceId, data: { requestId, networkId, csr, name } },
        operationSignal
      )
      // The coordinator assigns the owner, so userId comes from the reply. Every
      // other field must still match what this device actually submitted.
      const device = exactPeerObject(reply, [
        'deviceId',
        'userId',
        'name',
        'publicKey',
        'certificate'
      ])
      assertAccountId(device.deviceId)
      assertAccountId(device.userId)
      if (device.name !== name || device.publicKey !== publicKey)
        throw new PeerHelperError('p2p.identity_mismatch')
      const pending: PeerPendingEnrollment = {
        serviceId,
        networkId,
        name,
        userId: device.userId,
        requestId,
        publicKey,
        privateKey
      }
      assertPendingEnrollment(pending)
      this.#admit(operationSignal)
      const saved = await this.dependencies.credentials.prepareEnrollment(pending)
      this.#admit(operationSignal)
      // Confirm through the same readback path as a token enrollment: a reply
      // alone never becomes a stored credential.
      return this.#queryAndComplete(saved, operationSignal, issuedCredential(reply, pending))
    })
  }

  /**
   * Removes this device from a network and clears the local credential.
   *
   * The coordinator has no login-free removal: without one, any holder of a
   * deviceId could evict someone else's device. So this requires the owning
   * user's session, and the local credential is cleared only after the server
   * confirms the removal.
   */
  leave(
    serviceId: string,
    networkId: string,
    deviceId: string,
    signal: AbortSignal
  ): Promise<void> {
    assertAccountId(networkId)
    assertAccountId(deviceId)
    return this.#operation(serviceId, signal, async (operationSignal) => {
      await this.dependencies.services.activate(serviceId, operationSignal)
      const token = this.dependencies.accounts.sessionToken(serviceId)
      if (!token) throw new PeerHelperError('p2p.user_login_required')
      // Read the local credential first: removal needs its revision, and the
      // deviceId being removed must be the one actually stored here.
      const saved = await this.dependencies.credentials.loadRegistration(serviceId)
      if (saved.kind !== 'registered' || saved.credential.deviceId !== deviceId)
        throw new PeerHelperError('p2p.device_unregistered')
      await this.#call(
        'network.leave',
        { serviceId, data: { token, networkId, deviceId } },
        operationSignal
      )
      this.#admit(operationSignal)
      // Only now is the local credential dropped: the server has confirmed.
      await this.dependencies.credentials.remove(serviceId, saved.revision)
    })
  }

  /** Explicit user action only; preserves the original key/request, never automatic retry. */
  submitPending(
    serviceId: string,
    expectedRevision: string,
    signal: AbortSignal
  ): Promise<PeerRegistrationView> {
    return this.#operation(serviceId, signal, async (operationSignal) => {
      const pending = await this.#pending(serviceId, expectedRevision, operationSignal)
      await this.dependencies.services.activate(serviceId, operationSignal)
      return this.#submit(pending, operationSignal)
    })
  }

  /** A read-only server query followed by local commit; never replays enrollment. */
  recover(
    serviceId: string,
    expectedRevision: string,
    signal: AbortSignal
  ): Promise<PeerRegistrationView> {
    return this.#operation(serviceId, signal, async (operationSignal) => {
      const pending = await this.#pending(serviceId, expectedRevision, operationSignal)
      await this.dependencies.services.activate(serviceId, operationSignal)
      await this.#user(pending.enrollment, operationSignal)
      return this.#queryAndComplete(pending, operationSignal)
    })
  }

  async #pending(
    serviceId: string,
    expectedRevision: string,
    signal: AbortSignal
  ): Promise<PeerPendingEnrollmentReadback> {
    assertAccountId(expectedRevision, 64)
    const saved = await this.dependencies.credentials.loadRegistration(serviceId)
    this.#admit(signal)
    if (saved.kind !== 'pending') throw new PeerHelperError('p2p.enrollment_state_mismatch')
    if (saved.revision !== expectedRevision) throw new PeerHelperError('p2p.credential_conflict')
    if (saved.enrollment.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
    return saved
  }

  async #submit(
    saved: PeerPendingEnrollmentReadback,
    signal: AbortSignal
  ): Promise<PeerRegistrationView> {
    const { enrollment } = saved
    await this.#user(enrollment, signal)
    const result = exactPeerObject(
      await this.#call('device.createCSR', { privateKey: enrollment.privateKey }, signal),
      ['csr']
    )
    if (
      typeof result.csr !== 'string' ||
      !result.csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----') ||
      Buffer.byteLength(result.csr) > 16 * 1024
    )
      throw new PeerHelperError('p2p.invalid_csr')
    const grant = await this.dependencies.accounts.enrollmentGrant(
      enrollment.serviceId,
      enrollment.networkId,
      enrollment.userId,
      signal
    )
    this.#admit(signal)
    const reply = await this.#call(
      'device.enroll',
      {
        serviceId: enrollment.serviceId,
        data: {
          requestId: enrollment.requestId,
          token: grant.token,
          csr: result.csr,
          name: enrollment.name
        }
      },
      signal
    )
    const issued = issuedCredential(reply, enrollment)
    return this.#queryAndComplete(saved, signal, issued)
  }

  async #queryAndComplete(
    saved: PeerPendingEnrollmentReadback,
    signal: AbortSignal,
    expected?: PeerCredential
  ): Promise<PeerRegistrationView> {
    const { enrollment } = saved
    const result = await this.#call(
      'device.enrollmentResult',
      {
        serviceId: enrollment.serviceId,
        data: {
          requestId: enrollment.requestId,
          privateKey: enrollment.privateKey
        }
      },
      signal
    )
    const credential = issuedCredential(result, enrollment)
    if (expected && !sameCredential(expected, credential))
      throw new PeerHelperError('p2p.enrollment_result_unconfirmed')
    await this.dependencies.services.requireSaved(enrollment.serviceId)
    this.#admit(signal)
    const completed = await this.dependencies.credentials.completeEnrollment(
      credential,
      saved.revision
    )
    this.#admit(signal)
    if (!sameCredential(completed.credential, credential))
      throw new PeerHelperError('p2p.enrollment_result_unconfirmed')
    return registeredView(completed.credential, completed.revision)
  }

  async #user(enrollment: PeerPendingEnrollment, signal: AbortSignal): Promise<void> {
    const user = await this.dependencies.accounts.currentUser(enrollment.serviceId, signal)
    if (user.userId !== enrollment.userId) throw new PeerHelperError('p2p.user_scope_mismatch')
  }

  async #call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    this.#admit(signal)
    const result = await this.dependencies.rpc.call(method, payload, signal)
    this.#admit(signal)
    return result
  }

  async #operation<T>(
    serviceId: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    assertAccountId(serviceId, 64)
    this.#admit(signal)
    if (this.#busy.has(serviceId)) throw new PeerHelperError('p2p.service_busy')
    this.#busy.add(serviceId)
    try {
      const combined = AbortSignal.any([signal, this.#lifetime.signal])
      await this.dependencies.services.requireSaved(serviceId)
      this.#admit(combined)
      return await operation(combined)
    } finally {
      this.#busy.delete(serviceId)
    }
  }

  #admit(signal: AbortSignal): void {
    if (this.#lifetime.signal.aborted) throw new PeerHelperError('p2p.helper_unavailable')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
  }
}

function issuedCredential(value: unknown, pending: PeerPendingEnrollment): PeerCredential {
  const device = exactPeerObject(value, ['deviceId', 'userId', 'name', 'publicKey', 'certificate'])
  assertAccountId(device.deviceId)
  if (
    device.userId !== pending.userId ||
    device.name !== pending.name ||
    device.publicKey !== pending.publicKey
  )
    throw new PeerHelperError('p2p.identity_mismatch')
  return {
    serviceId: pending.serviceId,
    deviceId: device.deviceId,
    userId: pending.userId,
    name: pending.name,
    publicKey: pending.publicKey,
    privateKey: pending.privateKey,
    certificate: base64(device.certificate, 1, 16 * 1024)
  }
}

function registeredView(credential: PeerCredential, revision: string): PeerRegistrationView {
  const { serviceId, deviceId, userId, name, publicKey } = credential
  return { kind: 'registered', serviceId, deviceId, userId, name, publicKey, revision }
}

function sameCredential(left: PeerCredential, right: PeerCredential): boolean {
  return (Object.keys(right) as (keyof PeerCredential)[]).every(
    (field) => left[field] === right[field]
  )
}

function base64(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new PeerHelperError('p2p.credential_invalid')
  const decoded = Buffer.from(value, 'base64')
  const valid =
    decoded.length >= minimum && decoded.length <= maximum && decoded.toString('base64') === value
  decoded.fill(0)
  if (!valid) throw new PeerHelperError('p2p.credential_invalid')
  return value
}
