import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreSecretPort } from '../core/secrets'
import { PeerCredentialStore, type PeerCredential } from './credentials'
import { PeerHelperError } from './wire'

// A reversible stand-in for the OS safeStorage: the migration logic only
// needs encrypt/decrypt to round-trip through the persisted file format.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (bytes: Buffer) => bytes.toString('utf8').slice(4)
  }
}))

// Generated once with a Go helper: a self-signed ed25519 identity that
// satisfies assertPeerCredential's key, certificate and CN checks.
const credential: PeerCredential = {
  serviceId: '0def8197fda5',
  deviceId: 'e79659c33d94',
  userId: '99366d20795d',
  name: 'migration-test-device',
  publicKey: 'BVDgn9dw8miFSywIvnkKMDvat3liLfPm/Vyuvdng9is=',
  privateKey:
    'm6UeobVM1YnnUopnBylTiXLRYl574lvt9+F5RsbDhnkFUOCf13DyaIVLLAi+eQowO9q3eWIt8+b9XK692eD2Kw==',
  certificate:
    'MIHuMIGhoAMCAQICAQEwBQYDK2VwMBcxFTATBgNVBAMTDGU3OTY1OWMzM2Q5NDAeFw0yNjA5MTIxMzM1NDNaFw0yNzA5MTIxNDM1NDNaMBcxFTATBgNVBAMTDGU3OTY1OWMzM2Q5NDAqMAUGAytlcAMhAAVQ4J/XcPJohUssCL55CjA72rd5Yi3z5v1crr3Z4PYroxIwEDAOBgNVHQ8BAf8EBAMCB4AwBQYDK2VwA0EAL8KHVOYF4LlAaqN/3Utm77d3hIuX3FfkJB3CeEePEr342YaxBvc/z5jVQbfcR5GjjcNkUsgBU/quYb/Knwt8Dg=='
}

/** An in-memory native provider with injectable failures. */
function fakeSecrets(fail?: (op: string) => Error | undefined): CoreSecretPort & {
  store: Map<string, Buffer>
} {
  const store = new Map<string, Buffer>()
  return {
    store,
    async get(key) {
      const error = fail?.('get')
      if (error) throw error
      return store.get(key)
    },
    async set(key, value) {
      const error = fail?.('set')
      if (error) throw error
      store.set(key, Buffer.from(value))
    },
    async delete(key) {
      const error = fail?.('delete')
      if (error) throw error
      store.delete(key)
    }
  }
}

async function legacyRoot(): Promise<{
  root: () => Promise<string>
  file: string
  dispose: () => Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dshker-migration-'))
  const settings = join(dir, 'settings')
  const credentials = join(settings, 'dsh-launcher', 'p2p-credentials')
  await mkdir(credentials, { recursive: true })
  return {
    root: () => Promise.resolve(settings),
    file: join(credentials, credential.serviceId + '.json'),
    dispose: () => rm(dir, { recursive: true, force: true })
  }
}

/** Writes the record exactly the way the previous release did. */
async function writeLegacyRecord(file: string, value: unknown = credential): Promise<void> {
  const ciphertext = Buffer.from('enc:' + JSON.stringify(value), 'utf8')
  const record = {
    format: 'dshker.peer-credential',
    version: 1,
    ciphertext: ciphertext.toString('base64')
  }
  await writeFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/** A pending enrollment shaped exactly like the one the previous release wrote. */
const pending = {
  serviceId: credential.serviceId,
  requestId: 'e'.repeat(12),
  networkId: 'f'.repeat(12),
  userId: credential.userId,
  name: credential.name,
  publicKey: credential.publicKey,
  privateKey: credential.privateKey
}

/** Writes a legacy pending enrollment, whose format tag selects the pending kind. */
async function writeLegacyEnrollment(file: string, value: unknown = pending): Promise<void> {
  const ciphertext = Buffer.from('enc:' + JSON.stringify(value), 'utf8')
  const record = {
    format: 'dshker.peer-enrollment',
    version: 1,
    ciphertext: ciphertext.toString('base64')
  }
  await writeFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
}

/** Writes the legacy session sidecar the previous release kept beside the record. */
async function writeLegacySession(file: string, value: unknown): Promise<void> {
  const ciphertext = Buffer.from('enc:' + JSON.stringify(value), 'utf8')
  const record = {
    format: 'dshker.peer-user-session',
    version: 1,
    ciphertext: ciphertext.toString('base64')
  }
  await writeFile(file + '.session', JSON.stringify(record) + '\n', {
    encoding: 'utf8',
    mode: 0o600
  })
}

// The legacy safeStorage record this suite migrates only ever existed on
// macOS and Windows (requireEncryption refuses linux); there is nothing to
// migrate from on Linux, so the suite runs where the upgrade path does.
describe.skipIf(process.platform === 'linux')(
  'PeerCredentialStore native-provider migration',
  () => {
    let cleanup: (() => Promise<void>) | undefined
    beforeEach(() => {
      cleanup = undefined
    })
    afterEach(async () => {
      await cleanup?.()
      vi.restoreAllMocks()
    })

    it('migrates a legacy record once: writes, verifies, then removes the file', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyRecord(file)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const read = await store.loadRegistration(credential.serviceId)
      expect(read.kind).toBe('registered')
      if (read.kind !== 'registered') return
      expect(read.credential.deviceId).toBe(credential.deviceId)
      expect(read.credential.privateKey).toBe(credential.privateKey)
      const stored = secrets.store.get('peer-credential:' + credential.serviceId)
      expect(stored?.toString('utf8')).toBe(JSON.stringify(credential))
      expect(read.revision).toBe(createHash('sha256').update(stored!).digest('hex'))
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('serves subsequent loads from the provider without touching disk', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyRecord(file)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      await store.loadRegistration(credential.serviceId)
      await rm(file, { force: true })
      const again = await store.loadRegistration(credential.serviceId)
      expect(again.kind).toBe('registered')
    })

    it('reports nothing stored when neither provider nor legacy has the record', async () => {
      const { root, dispose } = await legacyRoot()
      cleanup = dispose
      const store = new PeerCredentialStore(root, fakeSecrets())
      await expect(store.loadRegistration(credential.serviceId)).rejects.toMatchObject({
        code: 'p2p.credential_unavailable'
      })
    })

    it('keeps the legacy record when the provider write fails', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyRecord(file)
      const secrets = fakeSecrets(() => new PeerHelperError('p2p.secret_provider_unavailable'))
      const store = new PeerCredentialStore(root, secrets)
      await expect(store.loadRegistration(credential.serviceId)).rejects.toMatchObject({
        code: 'p2p.secret_provider_unavailable'
      })
      await expect(readFile(file, 'utf8')).resolves.toContain('dshker.peer-credential')
      expect(secrets.store.size).toBe(0)
    })

    it('routes new writes to the provider and clears any legacy file', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyRecord(file)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const created = await store.create(credential)
      expect(created.credential.deviceId).toBe(credential.deviceId)
      expect(secrets.store.get('peer-credential:' + credential.serviceId)).toBeDefined()
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('deletes from the provider and disk on remove', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyRecord(file)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const read = await store.loadRegistration(credential.serviceId)
      if (read.kind !== 'registered') throw new Error('expected registered')
      await store.remove(credential.serviceId, read.revision)
      expect(secrets.store.has('peer-credential:' + credential.serviceId)).toBe(false)
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('migrates a legacy pending enrollment to its own key exactly once', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      await writeLegacyEnrollment(file)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)

      const read = await store.loadRegistration(credential.serviceId)
      expect(read.kind).toBe('pending')
      if (read.kind !== 'pending') return
      expect(read.enrollment.requestId).toBe(pending.requestId)
      const stored = secrets.store.get('peer-enrollment:' + credential.serviceId)
      expect(stored?.toString('utf8')).toBe(JSON.stringify(pending))
      expect(read.revision).toBe(createHash('sha256').update(stored!).digest('hex'))
      // One file, one destination: the pending kind never lands on the
      // credential key, or a later load would read it as a registered identity.
      expect(secrets.store.has('peer-credential:' + credential.serviceId)).toBe(false)
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })

      await store.loadRegistration(credential.serviceId)
      expect(secrets.store.size).toBe(1)
    })

    it('completes an enrollment held by the provider and retires the pending key', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)

      const prepared = await store.prepareEnrollment(pending)
      expect(secrets.store.get('peer-enrollment:' + credential.serviceId)?.toString('utf8')).toBe(
        JSON.stringify(pending)
      )
      const completed = await store.completeEnrollment(credential, prepared.revision)
      expect(completed.credential.privateKey).toBe(credential.privateKey)
      expect(secrets.store.has('peer-enrollment:' + credential.serviceId)).toBe(false)
      expect(secrets.store.get('peer-credential:' + credential.serviceId)?.toString('utf8')).toBe(
        JSON.stringify(credential)
      )
      // The credential key wins on the next read, and nothing went to disk.
      const read = await store.loadRegistration(credential.serviceId)
      expect(read.kind).toBe('registered')
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses a second enrollment while the provider already holds a record', async () => {
      const { root, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      await store.prepareEnrollment(pending)
      await expect(store.prepareEnrollment(pending)).rejects.toMatchObject({
        code: 'p2p.credential_write_failed'
      })
      await store.completeEnrollment(
        credential,
        (await store.loadRegistration(credential.serviceId)).revision
      )
      await expect(store.prepareEnrollment(pending)).rejects.toMatchObject({
        code: 'p2p.credential_write_failed'
      })
    })

    it('keeps the pending enrollment resumable when the credential write fails', async () => {
      const { root, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const prepared = await store.prepareEnrollment(pending)
      const failing = fakeSecrets((op) =>
        op === 'set' ? new PeerHelperError('p2p.secret_write_failed') : undefined
      )
      for (const [key, value] of secrets.store) failing.store.set(key, value)
      const broken = new PeerCredentialStore(root, failing)
      await expect(broken.completeEnrollment(credential, prepared.revision)).rejects.toMatchObject({
        code: 'p2p.secret_write_failed'
      })
      expect(failing.store.get('peer-enrollment:' + credential.serviceId)?.toString('utf8')).toBe(
        JSON.stringify(pending)
      )
    })

    it('renews the persisted user session instead of keeping the first token', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const first = { token: 'a'.repeat(64), expiresAt: 1_800_000_000_000 }
      const second = { token: 'b'.repeat(64), expiresAt: 1_900_000_000_000 }

      await store.saveUserSession(credential.serviceId, first)
      await store.saveUserSession(credential.serviceId, second)
      await expect(store.loadUserSession(credential.serviceId)).resolves.toEqual(second)
      expect(secrets.store.get('peer-user-session:' + credential.serviceId)?.toString('utf8')).toBe(
        JSON.stringify(second)
      )
      await expect(readFile(file + '.session')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('migrates a legacy session file once and then clears it', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      const session = { token: 'c'.repeat(64), expiresAt: 1_700_000_000_000 }
      await writeLegacySession(file, session)
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)

      await expect(store.loadUserSession(credential.serviceId)).resolves.toEqual(session)
      expect(secrets.store.get('peer-user-session:' + credential.serviceId)?.toString('utf8')).toBe(
        JSON.stringify(session)
      )
      await expect(readFile(file + '.session')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(store.loadUserSession(credential.serviceId)).resolves.toEqual(session)
      expect(secrets.store.size).toBe(1)
    })

    it('removes every record of one identity, not only the credential', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const prepared = await store.prepareEnrollment(pending)
      const registered = await store.completeEnrollment(credential, prepared.revision)
      await store.saveUserSession(credential.serviceId, {
        token: 'd'.repeat(64),
        expiresAt: 1_700_000_000_000
      })
      expect(secrets.store.size).toBe(2)

      await store.remove(credential.serviceId, registered.revision)
      expect(secrets.store.size).toBe(0)
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(file + '.session')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(store.loadUserSession(credential.serviceId)).resolves.toBeUndefined()
    })

    it('refuses a session no load could ever return', async () => {
      const { root, dispose } = await legacyRoot()
      cleanup = dispose
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      await expect(
        store.saveUserSession(credential.serviceId, { token: 'short', expiresAt: 1 })
      ).rejects.toMatchObject({ code: 'p2p.credential_invalid' })
      expect(secrets.store.size).toBe(0)
    })
  }
)
