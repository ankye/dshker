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
  /** The network used for this enrollment; absent only in legacy credentials. */
  networkId?: string
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
 * When a core secret port is injected, all three records this store owns — the
 * durable device credential, the pending enrollment and the persisted user
 * session — live in the native provider behind dshkerd. Loads consult the core
 * first, a legacy safeStorage record still on disk is migrated once (read,
 * written into the provider, verified by read-back, then the legacy file
 * removed), and new writes go to the core so the two stores never diverge
 * again. Every migration is per record kind, so a half-upgraded machine cannot
 * end up reading one kind from the core and writing the other to disk. */
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
    return this.#serialize(async () => {
      const read = await this.#readRouted(serviceId)
      if (read.kind !== 'pending') throw new PeerHelperError('p2p.enrollment_state_mismatch')
      return { revision: read.revision, enrollment: read.enrollment }
    })
  }

  /**
   * Starts one enrollment. Publication is exclusive: neither a registered
   * credential nor another pending record may already exist for the service, so
   * a repeated enrollment cannot overwrite the identity it is enrolling.
   */
  prepareEnrollment(enrollment: PeerPendingEnrollment): Promise<PeerPendingEnrollmentReadback> {
    assertPendingEnrollment(enrollment)
    const saved = { ...enrollment }
    return this.#serialize(async () => {
      if (this.#secrets) {
        if ((await this.#readRegistrationIfAny(saved.serviceId)) !== undefined)
          throw new PeerHelperError('p2p.credential_write_failed')
        return this.#writeCoreEnrollment(saved)
      }
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
      const previous = await this.#readRouted(saved.serviceId)
      if (previous.kind !== 'pending') throw new PeerHelperError('p2p.enrollment_state_mismatch')
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
        // The pending record is retired only after the credential is provably
        // stored, so a provider failure leaves the enrollment resumable.
        await this.#secrets.delete(this.#enrollmentKey(saved.serviceId))
        await this.#unlinkLegacy(saved.serviceId)
        return readback
      }
      const path = await this.#path(saved.serviceId, false)
      await publishSecret(path, encryptCredential(saved), true)
      return this.#read(path, saved.serviceId)
    })
  }

  create(credential: PeerCredential): Promise<PeerCredentialReadback> {
    return this.#serialize(async () => {
      assertPeerCredential(credential)
      if (this.#secrets) {
        const readback = await this.#writeCore(credential, undefined)
        await this.#secrets.delete(this.#enrollmentKey(credential.serviceId))
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
        // Every record of that identity goes together: a session token left
        // behind would outlive the coordinator it was issued for.
        await this.#secrets.delete(this.#coreKey(serviceId))
        await this.#secrets.delete(this.#enrollmentKey(serviceId))
        await this.#secrets.delete(this.#sessionKey(serviceId))
        await this.#unlinkLegacy(serviceId)
        await this.#unlinkLegacySession(serviceId)
        return
      }
      const path = await this.#path(serviceId, false)
      await unlink(path)
      await this.#unlinkLegacySession(serviceId)
    })
  }

  /**
   * Persists the user session token for one service so a restart does not
   * demand the password again. The server remains authoritative for expiry.
   *
   * Every successful login or renewal writes here, so this is an upsert on both
   * paths. The legacy file published exclusively and therefore kept whatever
   * token it saw first: a renewed session was dropped on the floor, and the next
   * restart presented the stale one and asked for the password again.
   */
  saveUserSession(serviceId: string, session: PeerUserSessionSecret): Promise<void> {
    return this.#serialize(async () => {
      // Validated inside the promise on purpose: the caller attaches .catch(),
      // and a synchronous throw would escape it into the login flow.
      const saved = assertUserSession(session)
      if (this.#secrets) {
        await this.#writeCoreSession(serviceId, saved)
        await this.#unlinkLegacySession(serviceId)
        return
      }
      const path = await this.#path(serviceId, true)
      await publishSecret(path + '.session', encryptSecret(saved, 'dshker.peer-user-session'), true)
    })
  }

  /** Reads the persisted session, migrating a legacy file once. */
  loadUserSession(serviceId: string): Promise<PeerUserSessionSecret | undefined> {
    return this.#serialize(async () => {
      const fromCore = await this.#readCoreSession(serviceId)
      if (fromCore !== undefined) return fromCore
      const path = await this.#sessionPath(serviceId)
      if (path === undefined) return undefined
      const legacy = await readLegacySession(path)
      if (legacy === undefined || !this.#secrets) return legacy
      await this.#writeCoreSession(serviceId, legacy)
      await this.#unlinkLegacySession(serviceId)
      return legacy
    })
  }

  removeUserSession(serviceId: string): Promise<void> {
    return this.#serialize(async () => {
      if (this.#secrets) await this.#secrets.delete(this.#sessionKey(serviceId))
      await this.#unlinkLegacySession(serviceId)
    })
  }

  /** The persisted session file, or undefined when the store has no directory yet. */
  async #sessionPath(serviceId: string): Promise<string | undefined> {
    const path = await this.#path(serviceId, false).catch((error: unknown) => {
      if (error instanceof PeerHelperError && error.code === 'p2p.credential_unavailable')
        return undefined
      throw error
    })
    return path === undefined ? undefined : path + '.session'
  }

  async #path(serviceId: string, create: boolean): Promise<string> {
    if (!/^[0-9a-f]{12}$/.test(serviceId)) throw new PeerHelperError('p2p.invalid_service_identity')
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

  /** The core-store key of one service's pending enrollment. */
  #enrollmentKey(serviceId: string): string {
    return 'peer-enrollment:' + serviceId
  }

  /** The core-store key of one service's persisted user session. */
  #sessionKey(serviceId: string): string {
    return 'peer-user-session:' + serviceId
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

  /** Reads the pending enrollment from the native provider. */
  async #readCoreEnrollment(serviceId: string): Promise<PeerPendingEnrollmentReadback | undefined> {
    if (!this.#secrets) return undefined
    const value = await this.#secrets.get(this.#enrollmentKey(serviceId))
    if (value === undefined || value.length === 0) return undefined
    const enrollment = parsePeerJson(value.toString('utf8'))
    assertPendingEnrollment(enrollment)
    if (enrollment.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
    return {
      revision: createHash('sha256').update(value).digest('hex'),
      enrollment
    }
  }

  /** Writes the pending enrollment and proves the write by reading it back. */
  async #writeCoreEnrollment(
    enrollment: PeerPendingEnrollment
  ): Promise<PeerPendingEnrollmentReadback> {
    if (!this.#secrets) throw new PeerHelperError('p2p.secret_provider_unavailable')
    await this.#secrets.set(
      this.#enrollmentKey(enrollment.serviceId),
      Buffer.from(JSON.stringify(enrollment), 'utf8')
    )
    const readback = await this.#readCoreEnrollment(enrollment.serviceId)
    if (readback === undefined || readback.enrollment.privateKey !== enrollment.privateKey)
      throw new PeerHelperError('p2p.credential_write_failed')
    return readback
  }

  /** Reads the persisted user session from the native provider. */
  async #readCoreSession(serviceId: string): Promise<PeerUserSessionSecret | undefined> {
    if (!this.#secrets) return undefined
    const value = await this.#secrets.get(this.#sessionKey(serviceId))
    if (value === undefined || value.length === 0) return undefined
    return parseUserSession(parsePeerJson(value.toString('utf8')))
  }

  /** Writes the persisted user session and proves the write by reading it back. */
  async #writeCoreSession(serviceId: string, session: PeerUserSessionSecret): Promise<void> {
    if (!this.#secrets) throw new PeerHelperError('p2p.secret_provider_unavailable')
    await this.#secrets.set(
      this.#sessionKey(serviceId),
      Buffer.from(JSON.stringify(session), 'utf8')
    )
    const readback = await this.#readCoreSession(serviceId)
    if (
      readback === undefined ||
      readback.token !== session.token ||
      readback.expiresAt !== session.expiresAt
    )
      throw new PeerHelperError('p2p.credential_write_failed')
  }

  /**
   * The single load path: the native provider first, then the legacy
   * safeStorage file. Whichever record kind the file holds is migrated once to
   * that kind's own key, so the two stores never hold the same record twice and
   * a half-upgraded machine cannot read one kind from the core while the other
   * is still written to disk.
   */
  async #readRouted(serviceId: string): Promise<PeerRegistrationReadback> {
    const fromCore = await this.#readCore(serviceId)
    if (fromCore !== undefined) return { kind: 'registered', ...fromCore }
    const pending = await this.#readCoreEnrollment(serviceId)
    if (pending !== undefined) return { kind: 'pending', ...pending }
    const path = await this.#path(serviceId, false)
    const read = await this.#readRegistration(path, serviceId)
    if (!this.#secrets) return read
    // One-shot migration: the legacy record is removed only after the native
    // provider provably holds the identical record.
    const migrated =
      read.kind === 'registered'
        ? { kind: 'registered' as const, ...(await this.#writeCore(read.credential, undefined)) }
        : { kind: 'pending' as const, ...(await this.#writeCoreEnrollment(read.enrollment)) }
    await unlink(path)
    return migrated
  }

  /** The routed read where "nothing is stored at all" is undefined, not a refusal. */
  async #readRegistrationIfAny(serviceId: string): Promise<PeerRegistrationReadback | undefined> {
    try {
      return await this.#readRouted(serviceId)
    } catch (error) {
      if (error instanceof PeerHelperError && error.code === 'p2p.credential_unavailable')
        return undefined
      throw error
    }
  }

  /** Best-effort removal of a legacy record that may or may not exist. */
  async #unlinkLegacy(serviceId: string): Promise<void> {
    const path = await this.#path(serviceId, false).catch(() => undefined)
    if (path === undefined) return
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }

  /** Best-effort removal of the legacy session file, which may not exist. */
  async #unlinkLegacySession(serviceId: string): Promise<void> {
    const path = await this.#sessionPath(serviceId).catch(() => undefined)
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
  const baseFields = [
    'serviceId',
    'deviceId',
    'userId',
    'name',
    'publicKey',
    'privateKey',
    'certificate'
  ] as const
  // v1 credentials written before the network was retained remain readable,
  // but new credentials include the authoritative network ID. Never infer it
  // from an account list: a device may be bound to more than one network.
  const hasNetworkId =
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'networkId' in value
  const record = exactPeerObject(value, hasNetworkId ? [...baseFields, 'networkId'] : baseFields)
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
    !/^[0-9a-f]{12}$/.test(record.serviceId as string) ||
    !/^[0-9a-f]{12}$/.test(record.deviceId as string) ||
    !/^[0-9a-f]{12}$/.test(record.userId as string) ||
    !(record.name as string).trim() ||
    (record.name as string).trim() !== record.name ||
    Buffer.byteLength(record.name as string) > 256 ||
    /[\x00\r\n]/.test(record.name as string)
  )
    throw new PeerHelperError('p2p.credential_invalid')
  if (hasNetworkId && !/^[0-9a-f]{12}$/.test(record.networkId as string))
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

/**
 * One persisted session, or undefined when the value is not one.
 *
 * The same predicate guards writing and reading, so a session can never be
 * stored in a shape the next load would refuse to hand back.
 */
export function parseUserSession(value: unknown): PeerUserSessionSecret | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const session = value as Record<string, unknown>
  if (
    typeof session.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(session.token) ||
    !Number.isSafeInteger(session.expiresAt)
  )
    return undefined
  return { token: session.token, expiresAt: session.expiresAt as number }
}

/** The write-side half of the same rule: refuse a session no load could return. */
export function assertUserSession(value: unknown): PeerUserSessionSecret {
  const session = parseUserSession(value)
  if (session === undefined) throw new PeerHelperError('p2p.credential_invalid')
  return session
}

/** Decodes one legacy session file, treating anything unreadable as absent. */
async function readLegacySession(path: string): Promise<PeerUserSessionSecret | undefined> {
  const encoded = await readFile(path, 'utf8').catch(() => undefined)
  if (encoded === undefined) return undefined
  try {
    const record = exactPeerObject(parsePeerJson(encoded), ['format', 'version', 'ciphertext'])
    if (record.format !== 'dshker.peer-user-session' || typeof record.ciphertext !== 'string')
      return undefined
    return parseUserSession(
      parsePeerJson(safeStorage.decryptString(decodeBase64(record.ciphertext)))
    )
  } catch {
    return undefined
  }
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
