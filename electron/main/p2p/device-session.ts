import type {
  CertificateRecoveryAccounts,
  PeerCertificateRecoveryScope
} from './certificate-recovery-scope'
import type { PeerCredential, PeerCredentialStore } from './credentials'
import type { PeerChannel } from './runtime-host'
import { exactPeerObject, PeerHelperError } from './wire'

interface DeviceSession {
  rpc: Pick<PeerChannel, 'call'>
  accounts: CertificateRecoveryAccounts
}

/** Synchronizes certificates without transferring ownership of the enrolled identity. */
export class PeerDeviceSession {
  readonly #restored = new Set<string>()
  readonly #pending = new Map<string, Promise<void>>()
  readonly #owners = new Map<string, object>()

  constructor(
    private readonly credentials: Pick<PeerCredentialStore, 'load' | 'replace'>,
    private readonly recoveryScopes: Pick<PeerCertificateRecoveryScope, 'resolve'>
  ) {}

  ready(
    serviceId: string,
    session: DeviceSession,
    signal: AbortSignal,
    reportedAccount: (credential: PeerCredential) => Promise<string>,
    maintain: boolean | 'after-login' = false
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(new PeerHelperError('p2p.request_cancelled'))
    if (!this.#owners.has(serviceId)) this.#owners.set(serviceId, {})
    const owner = this.#owners.get(serviceId)
    const existing = this.#pending.get(serviceId)
    if (existing && maintain === 'after-login') {
      // A newly authorized login must run after maintenance that captured the
      // previous account state, regardless of that earlier attempt's outcome.
      const refresh = () => {
        if (this.#owners.get(serviceId) !== owner)
          throw new PeerHelperError('p2p.request_cancelled')
        return this.ready(serviceId, session, signal, reportedAccount, true)
      }
      return existing.then(refresh, refresh)
    }
    if (existing) return existing
    if (this.#restored.has(serviceId) && !maintain) return Promise.resolve()
    const assertCurrent = () => {
      if (signal.aborted || this.#pending.get(serviceId) !== pending)
        throw new PeerHelperError('p2p.request_cancelled')
    }
    const pending = this.#maintain(
      serviceId,
      session,
      signal,
      reportedAccount,
      assertCurrent
    ).finally(() => {
      if (this.#pending.get(serviceId) === pending) this.#pending.delete(serviceId)
    })
    this.#pending.set(serviceId, pending)
    return pending
  }

  forget(serviceId: string): void {
    this.#restored.delete(serviceId)
    this.#pending.delete(serviceId)
    this.#owners.delete(serviceId)
  }

  clear(): void {
    this.#restored.clear()
    this.#pending.clear()
    this.#owners.clear()
  }

  async #maintain(
    serviceId: string,
    session: DeviceSession,
    signal: AbortSignal,
    reportedAccount: (credential: PeerCredential) => Promise<string>,
    assertLifecycle: () => void
  ): Promise<void> {
    const saved = await this.credentials.load(serviceId).catch((error: unknown) => {
      if (error instanceof PeerHelperError && error.code === 'p2p.credential_unavailable')
        throw new PeerHelperError('p2p.device_unregistered')
      throw error
    })
    assertLifecycle()
    if (saved.credential.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
    const original = saved.credential
    const maintained = await this.#certificate(original, session, signal, assertLifecycle)
    const assertCurrent = maintained.assertCurrent
    const result = exactPeerObject(maintained.response, ['deviceId', 'publicKey', 'certificate'])
    assertCurrent()
    if (result.deviceId !== original.deviceId || result.publicKey !== original.publicKey)
      throw new PeerHelperError('p2p.identity_mismatch')
    assertCertificateEncoding(result.certificate)
    const credential = { ...original, certificate: result.certificate }
    if (credential.certificate !== original.certificate) {
      const written = await this.credentials.replace(credential, saved.revision, assertCurrent)
      assertCurrent()
      assertCredentialReadback(credential, written.credential)
      const readback = await this.credentials.load(serviceId)
      assertCurrent()
      if (readback.revision !== written.revision)
        throw new PeerHelperError('p2p.credential_conflict')
      assertCredentialReadback(credential, readback.credential)
    }
    if (this.#restored.has(serviceId)) return
    const userId = await reportedAccount(credential)
    assertCurrent()
    const restored = exactPeerObject(
      await session.rpc.call(
        'device.restore',
        {
          serviceId,
          data: {
            device: publicDevice(credential),
            accountUserId: userId,
            privateKey: credential.privateKey,
            pins: []
          }
        },
        signal
      ),
      ['deviceId']
    )
    assertCurrent()
    if (restored.deviceId !== credential.deviceId)
      throw new PeerHelperError('p2p.identity_mismatch')
    this.#restored.add(serviceId)
  }

  async #certificate(
    original: PeerCredential,
    session: DeviceSession,
    signal: AbortSignal,
    assertLifecycle: () => void
  ): Promise<{ response: unknown; assertCurrent: () => void }> {
    const serviceId = original.serviceId
    const token = session.accounts.hasSession(serviceId)
      ? session.accounts.sessionToken(serviceId)
      : undefined
    try {
      const response = await requestCertificate(
        session,
        original,
        original.networkId,
        token,
        signal
      )
      return { response, assertCurrent: assertLifecycle }
    } catch (error) {
      assertLifecycle()
      if (
        !(error instanceof PeerHelperError) ||
        error.code !== 'p2p.certificate_recovery_required' ||
        original.networkId !== undefined ||
        token === undefined
      )
        throw error
      if (
        !session.accounts.hasSession(serviceId) ||
        session.accounts.sessionToken(serviceId) !== token
      )
        throw new PeerHelperError('p2p.request_cancelled')
      const scope = await this.recoveryScopes.resolve(
        serviceId,
        original.deviceId,
        session.accounts,
        token,
        signal,
        assertLifecycle
      )
      await scope.recheck()
      scope.assertCurrent()
      const response = await requestCertificate(session, original, scope.networkId, token, signal)
      await scope.recheck()
      return { response, assertCurrent: scope.assertCurrent }
    }
  }
}

function requestCertificate(
  session: DeviceSession,
  credential: PeerCredential,
  networkId: string | undefined,
  token: string | undefined,
  signal: AbortSignal
): Promise<unknown> {
  return session.rpc.call(
    'device.certificate',
    {
      serviceId: credential.serviceId,
      data: {
        device: publicDevice(credential),
        privateKey: credential.privateKey,
        ...(networkId === undefined ? {} : { networkId }),
        ...(token === undefined ? {} : { token })
      }
    },
    signal
  )
}

function publicDevice(credential: PeerCredential) {
  const { deviceId, userId, name, publicKey, certificate } = credential
  return { deviceId, userId, name, publicKey, certificate }
}

function assertCertificateEncoding(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 21_848)
    throw new PeerHelperError('p2p.invalid_device_certificate')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > 16 * 1024 || bytes.toString('base64') !== value)
    throw new PeerHelperError('p2p.invalid_device_certificate')
}

function assertCredentialReadback(expected: PeerCredential, actual: PeerCredential): void {
  const fields = Object.keys(expected) as (keyof PeerCredential)[]
  if (
    Object.keys(actual).length !== fields.length ||
    fields.some((field) => actual[field] !== expected[field])
  )
    throw new PeerHelperError('p2p.credential_write_failed')
}
