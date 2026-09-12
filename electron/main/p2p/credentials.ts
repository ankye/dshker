import { safeStorage } from 'electron'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  X509Certificate
} from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { exactPeerObject, parsePeerJson, PeerHelperError } from './wire'
import { assertPendingEnrollment, type PeerPendingEnrollment } from './enrollment-record'
import type { CoreSecretPort } from '../core/secrets'

/** Main-only device material; neither this record nor its cipher enters UI state. */
export interface PeerCredential {
  serviceId: string
  deviceId: string
  userId: string
  name: string
  publicKey: string
  privateKey: string
  certificate: string
}

export interface PeerCredentialReadback {
  revision: string
  credential: PeerCredential
}

export interface PeerPendingEnrollmentReadback {
  revision: string
  enrollment: PeerPendingEnrollment
}

export type PeerRegistrationReadback =
  | ({ kind: 'pending' } & PeerPendingEnrollmentReadback)
  | ({ kind: 'registered' } & PeerCredentialReadback)

/** Uses the real OS provider; unavailable encryption never becomes plaintext.
 *
 * When a core secret port is injected, the durable device credential record
 * moves to the native provider behind dshkerd: loads consult the core first,
 * a legacy safeStorage record still on disk is migrated once (read, written
 * into the provider, verified by read-back, then the legacy file removed),
 * and new writes go to the core so the two stores never diverge again.
 * Pending enrollments and user sessions stay on the legacy path until the
 * state machine itself moves into the core. */
export class PeerCredentialStore {
  #pending: Promise<unknown> = Promise.resolve()
  readonly #secrets: CoreSecretPort | undefined
  constructor(
    private readonly resolveSettingsRoot: () => Promise<string>,
    secrets?: CoreSecretPort
  ) {
    this.#secrets = secrets
  }

  load(serviceId: string): Promise<PeerCredentialReadback> {
    return this.#serialize(async () => {
      const read = await this.#readRouted(serviceId)
      if (read.kind !== 'registered') throw new PeerHelperError('p2p.credential_unavailable')
      return { revision: read.revision, credential: read.credential }
    })
  }

  /** Select the persisted state by its explicit format, never by catching a failed load. */
  loadRegistration(serviceId: string): Promise<PeerRegistrationReadback> {
    return this.#serialize(async () => this.#readRouted(serviceId))
  }

  loadPendingEnrollment(serviceId: string): Promise<PeerPendingEnrollmentReadback> {
    return this.#serialize(async () =>
      this.#readPending(await this.#path(serviceId, false), serviceId)
    )
  }

  prepareEnrollment(enrollment: PeerPendingEnrollment): Promise<PeerPendingEnrollmentReadback> {
    assertPendingEnrollment(enrollment)
    const saved = { ...enrollment }
    return this.#serialize(async () => {
      const path = await this.#path(saved.serviceId, true)
      await publishSecret(path, encryptSecret(saved, 'dshker.peer-enrollment'), false)
      return this.#readPending(path, saved.serviceId)
    })
  }

  /** Atomically replace the pending key only after authenticated server readback. */
  completeEnrollment(
    credential: PeerCredential,
    expectedRevision: string
  ): Promise<PeerCredentialReadback> {
    assertPeerCredential(credential)
    const saved = { ...credential }
    return this.#serialize(async () => {
      const path = await this.#path(saved.serviceId, false)
      const previous = await this.#readPending(path, saved.serviceId)
      if (
        previous.revision !== expectedRevision ||
        previous.enrollment.userId !== saved.userId ||
        previous.enrollment.publicKey !== saved.publicKey ||
        previous.enrollment.privateKey !== saved.privateKey ||
        previous.enrollment.name !== saved.name
      )
        throw new PeerHelperError('p2p.credential_conflict')
      if (this.#secrets) {
        const readback = await this.#writeCore(saved, undefined)
        await this.#unlinkLegacy(saved.serviceId)
        return readback
      }
      await publishSecret(path, encryptCredential(saved), true)
      return this.#read(path, saved.serviceId)
    })
  }

  create(credential: PeerCredential): Promise<PeerCredentialReadback> {
    return this.#serialize(async () => {
      assertPeerCredential(credential)
      if (this.#secrets) {
        const readback = await this.#writeCore(credential, undefined)
        await this.#unlinkLegacy(credential.serviceId)
        return readback
      }
      const path = await this.#path(credential.serviceId, true)
      const encoded = encryptCredential(credential)
      const temporary = path + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(encoded)
        await file.sync()
        await file.close()
        // Publish a complete file exclusively; never expose a partial first write
        // or overwrite an existing identity after a crash/repeated enrollment.
        await link(temporary, path)
      } catch {
        throw new PeerHelperError('p2p.credential_create_failed')
      } finally {
        await file.close()
        await unlink(temporary)
      }
      return this.#read(path, credential.serviceId)
    })
  }

  replace(credential: PeerCredential, expectedRevision: string): Promise<PeerCredentialReadback> {
    return this.#serialize(async () => {
      assertPeerCredential(credential)
      const previous = await this.#readRouted(credential.serviceId)
      const previousCredential = previous.kind === 'registered' ? previous.credential : undefined
      if (
        previousCredential === undefined ||
        previous.revision !== expectedRevision ||
        previousCredential.deviceId !== credential.deviceId ||
        previousCredential.userId !== credential.userId ||
        previousCredential.publicKey !== credential.publicKey
      )
        throw new PeerHelperError('p2p.credential_conflict')
      if (this.#secrets) return this.#writeCore(credential, previous)
      const path = await this.#path(credential.serviceId, false)
      const temporary = path + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(encryptCredential(credential))
        await file.sync()
        await file.close()
        await rename(temporary, path)
      } catch {
        await file.close()
        await unlink(temporary).catch(() => undefined)
        throw new PeerHelperError('p2p.credential_write_failed')
      }
      return this.#read(path, credential.serviceId)
    })
  }

  remove(serviceId: string, expectedRevision: string): Promise<void> {
    return this.#serialize(async () => {
      const previous = await this.#readRouted(serviceId)
      if (previous.revision !== expectedRevision)
        throw new PeerHelperError('p2p.credential_conflict')
      if (this.#secrets) {
        await this.#secrets.delete(this.#coreKey(serviceId))
        await this.#unlinkLegacy(serviceId)
        return
      }
      const path = await this.#path(serviceId, false)
      await unlink(path)
    })
  }

  /**
   * Persists the user session token for one service so a restart does not
   * demand the password again. Encrypted like every other secret; the server
   * remains authoritative for expiry.
   */
  saveUserSession(serviceId: string, session: PeerUserSessionSecret): Promise<void> {
    return this.#serialize(async () => {
      const path = await this.#path(serviceId, true)
      await publishSecret(
        path + '.session',
        encryptSecret(session, 'dshker.peer-user-session'),
        false
      )
    })
  }

  loadUserSession(serviceId: string): Promise<PeerUserSessionSecret | undefined> {
    return this.#serialize(async () => {
      const path = await this.#path(serviceId, false)
      const encoded = await readFile(path + '.session', 'utf8').catch(() => undefined)
      if (encoded === undefined) return undefined
      const record = exactPeerObject(parsePeerJson(encoded), ['format', 'version', 'ciphertext'])
      if (record.format !== 'dshker.peer-user-session' || typeof record.ciphertext !== 'string')
        return undefined
      const value = parsePeerJson(
        safeStorage.decryptString(decodeBase64(record.ciphertext as string))
      )
      if (typeof value !== 'object' || value === null) return undefined
      const secret = value as Record<string, unknown>
      if (
        typeof secret.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(secret.token) ||
        !Number.isSafeInteger(secret.expiresAt)
      )
        return undefined
      return { token: secret.token, expiresAt: secret.expiresAt as number }
    })
  }

  removeUserSession(serviceId: string): Promise<void> {
    return this.#serialize(async () => {
      const path = await this.#path(serviceId, false)
      await unlink(path + '.session').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    })
  }

  async #path(serviceId: string, create: boolean): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(serviceId)) throw new PeerHelperError('p2p.invalid_service_identity')
    const root = await this.resolveSettingsRoot()
    if (!isAbsolute(root)) throw new PeerHelperError('p2p.settings_root_required')
    const parent = join(root, 'dsh-launcher')
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PeerHelperError('p2p.settings_root_required')
    const directory = join(parent, 'p2p-credentials')
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
    // A first run before any enrollment has no credentials directory at all.
    // That is "nothing stored", not an internal error: surface the typed code so
    // the renderer can offer registration instead of showing a failure.
    const folder = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === 'ENOENT')
        throw new PeerHelperError('p2p.credential_unavailable')
      throw error
    })
    if (!folder.isDirectory() || folder.isSymbolicLink())
      throw new PeerHelperError('p2p.credential_invalid')
    return join(directory, serviceId + '.json')
  }

  async #read(path: string, serviceId: string): Promise<PeerCredentialReadback> {
    const result = await this.#readRegistration(path, serviceId)
    if (result.kind !== 'registered') throw new PeerHelperError('p2p.credential_invalid')
    return { revision: result.revision, credential: result.credential }
  }

  async #readPending(path: string, serviceId: string): Promise<PeerPendingEnrollmentReadback> {
    const result = await this.#readRegistration(path, serviceId)
    if (result.kind !== 'pending') throw new PeerHelperError('p2p.enrollment_state_mismatch')
    return { revision: result.revision, enrollment: result.enrollment }
  }

  async #readRegistration(path: string, serviceId: string): Promise<PeerRegistrationReadback> {
    try {
      requireEncryption()
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
        throw new PeerHelperError('p2p.credential_invalid')
      const encoded = await readFile(path, 'utf8')
      const record = exactPeerObject(parsePeerJson(encoded), ['format', 'version', 'ciphertext'])
      if (
        !['dshker.peer-credential', 'dshker.peer-enrollment'].includes(record.format as string) ||
        record.version !== 1 ||
        typeof record.ciphertext !== 'string'
      )
        throw new PeerHelperError('p2p.credential_invalid')
      const ciphertext = decodeBase64(record.ciphertext)
      const value = parsePeerJson(safeStorage.decryptString(ciphertext))
      const revision = createHash('sha256').update(encoded).digest('hex')
      if (record.format === 'dshker.peer-enrollment') {
        assertPendingEnrollment(value)
        if (value.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
        return { kind: 'pending', revision, enrollment: value }
      }
      assertPeerCredential(value)
      if (value.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
      return { kind: 'registered', revision, credential: value }
    } catch (error) {
      if (error instanceof PeerHelperError) throw error
      throw new PeerHelperError('p2p.credential_unavailable')
    }
  }

  /** The core-store key of one service's durable device credential. */
  #coreKey(serviceId: string): string {
    return 'peer-credential:' + serviceId
  }

  /** Reads the credential from the native provider; undefined means not stored. */
  async #readCore(serviceId: string): Promise<PeerCredentialReadback | undefined> {
    if (!this.#secrets) return undefined
    const value = await this.#secrets.get(this.#coreKey(serviceId))
    if (value === undefined || value.length === 0) return undefined
    const credential = parsePeerJson(value.toString('utf8'))
    assertPeerCredential(credential)
    if (credential.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
    return {
      revision: createHash('sha256').update(value).digest('hex'),
      credential
    }
  }

  /**
   * Writes the credential into the native provider and proves the write by
   * reading the exact bytes back before reporting success. `previous`, when
   * the record already exists somewhere, is checked for identity continuity.
   */
  async #writeCore(
    credential: PeerCredential,
    previous: PeerRegistrationReadback | undefined
  ): Promise<PeerCredentialReadback> {
    if (!this.#secrets) throw new PeerHelperError('p2p.secret_provider_unavailable')
    const registered = previous !== undefined && previous.kind === 'registered'
    if (
      registered &&
      (previous.credential.deviceId !== credential.deviceId ||
        previous.credential.userId !== credential.userId ||
        previous.credential.publicKey !== credential.publicKey)
    )
      throw new PeerHelperError('p2p.credential_conflict')
    const value = Buffer.from(JSON.stringify(credential), 'utf8')
    await this.#secrets.set(this.#coreKey(credential.serviceId), value)
    const readback = await this.#readCore(credential.serviceId)
    if (
      readback === undefined ||
      readback.credential.deviceId !== credential.deviceId ||
      readback.credential.userId !== credential.userId ||
      readback.credential.publicKey !== credential.publicKey ||
      readback.credential.privateKey !== credential.privateKey
    )
      throw new PeerHelperError('p2p.credential_write_failed')
    return readback
  }

  /**
   * The single load path: the native provider first, then the legacy
   * safeStorage file, migrating a registered legacy credential once before
   * returning it. A pending enrollment always comes from the legacy record.
   */
  async #readRouted(serviceId: string): Promise<PeerRegistrationReadback> {
    const fromCore = await this.#readCore(serviceId)
    if (fromCore !== undefined) return { kind: 'registered', ...fromCore }
    const path = await this.#path(serviceId, false)
    const read = await this.#readRegistration(path, serviceId)
    if (read.kind !== 'registered' || !this.#secrets) return read
    // One-shot migration: the legacy record is removed only after the native
    // provider provably holds the identical credential.
    const migrated = await this.#writeCore(read.credential, undefined)
    await unlink(path)
    return { kind: 'registered', ...migrated }
  }

  /** Best-effort removal of a legacy record that may or may not exist. */
  async #unlinkLegacy(serviceId: string): Promise<void> {
    const path = await this.#path(serviceId, false).catch(() => undefined)
    if (path === undefined) return
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation)
    this.#pending = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }
}

export function assertPeerCredential(value: unknown): asserts value is PeerCredential {
  const record = exactPeerObject(value, [
    'serviceId',
    'deviceId',
    'userId',
    'name',
    'publicKey',
    'privateKey',
    'certificate'
  ])
  for (const field of [
    'serviceId',
    'deviceId',
    'userId',
    'name',
    'publicKey',
    'privateKey',
    'certificate'
  ]) {
    if (typeof record[field] !== 'string') throw new PeerHelperError('p2p.credential_invalid')
  }
  if (
    !/^[0-9a-f]{64}$/.test(record.serviceId as string) ||
    !/^[0-9a-f]{32}$/.test(record.deviceId as string) ||
    !/^[0-9a-f]{32}$/.test(record.userId as string) ||
    !(record.name as string).trim() ||
    (record.name as string).trim() !== record.name ||
    Buffer.byteLength(record.name as string) > 256 ||
    /[\x00\r\n]/.test(record.name as string)
  )
    throw new PeerHelperError('p2p.credential_invalid')
  if (
    decodeBase64(record.publicKey as string).length !== 32 ||
    decodeBase64(record.privateKey as string).length !== 64 ||
    decodeBase64(record.certificate as string).length === 0 ||
    decodeBase64(record.certificate as string).length > 16 * 1024
  )
    throw new PeerHelperError('p2p.credential_invalid')
  const publicKey = decodeBase64(record.publicKey as string)
  const privateKey = decodeBase64(record.privateKey as string)
  try {
    const seed = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      privateKey.subarray(0, 32)
    ])
    const nativeKey = createPrivateKey({ key: seed, type: 'pkcs8', format: 'der' })
    seed.fill(0)
    const derived = createPublicKey(nativeKey).export({ type: 'spki', format: 'der' })
    const certificate = new X509Certificate(decodeBase64(record.certificate as string))
    if (
      !derived.subarray(-32).equals(publicKey) ||
      !privateKey.subarray(32).equals(publicKey) ||
      certificate.publicKey.asymmetricKeyType !== 'ed25519' ||
      !certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(derived) ||
      !certificate.subject.split('\n').includes(`CN=${record.deviceId}`)
    )
      throw new PeerHelperError('p2p.identity_mismatch')
  } catch (error) {
    if (error instanceof PeerHelperError) throw error
    throw new PeerHelperError('p2p.credential_invalid')
  } finally {
    privateKey.fill(0)
  }
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (!value || bytes.toString('base64') !== value)
    throw new PeerHelperError('p2p.credential_invalid')
  return bytes
}

function requireEncryption(): void {
  if (!['darwin', 'win32'].includes(process.platform) || !safeStorage.isEncryptionAvailable())
    throw new PeerHelperError('p2p.secure_storage_unavailable')
}

function encryptCredential(value: PeerCredential): string {
  return encryptSecret(value, 'dshker.peer-credential')
}

function encryptSecret(
  value: PeerCredential | PeerPendingEnrollment | PeerUserSessionSecret,
  format: string
): string {
  requireEncryption()
  const ciphertext = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  return JSON.stringify({ format, version: 1, ciphertext }) + '\n'
}

async function publishSecret(path: string, encoded: string, replace: boolean): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(encoded)
    await file.sync()
    await file.close()
    if (replace) await rename(temporary, path)
    else await link(temporary, path)
  } catch {
    throw new PeerHelperError('p2p.credential_write_failed')
  } finally {
    await file.close()
    if (!replace) await unlink(temporary)
    else
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw new PeerHelperError('p2p.credential_cleanup_failed')
      })
  }
}

/** Persisted login session: the token only; never the password. */
export interface PeerUserSessionSecret {
  token: string
  expiresAt: number
}
