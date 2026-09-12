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
  serviceId: 'b8f877496f1a6caa7f03def09871ec445934eb1e4d784e53dbfd5baafdce69a8',
  deviceId: 'c7f82c93ae0f5cd32703000b336b5981',
  userId: '99366d20795ddbbe733f0e4363ec9111',
  name: 'migration-test-device',
  publicKey: 'SiWm8UVhBPP8o4IJlxyR+Ilkgrau4X8cS/jm4df7Kro=',
  privateKey:
    'dCLaPHzmvcIvymXy/DrVO5X5lwLakN9W8buBoVr3EedKJabxRWEE8/yjggmXHJH4iWSCtq7hfxxL+Obh1/squg==',
  certificate:
    'MIIBFjCByaADAgECAgEBMAUGAytlcDArMSkwJwYDVQQDEyBjN2Y4MmM5M2FlMGY1Y2QzMjcwMzAwMGIzMzZiNTk4MTAeFw0yNjA5MTIxMzM1NDNaFw0yNzA5MTIxNDM1NDNaMCsxKTAnBgNVBAMTIGM3ZjgyYzkzYWUwZjVjZDMyNzAzMDAwYjMzNmI1OTgxMCowBQYDK2VwAyEASiWm8UVhBPP8o4IJlxyR+Ilkgrau4X8cS/jm4df7KrqjEjAQMA4GA1UdDwEB/wQEAwIHgDAFBgMrZXADQQBwDYsCUufn7DR4c7YDaNhXZTvOwCGa+xiRRz15G0NK4Mtq7wZpI4P+eo6haZokX95zYpfGhoByxzWf4Ajw7p0B'
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
async function writeLegacyRecord(file: string): Promise<void> {
  const ciphertext = Buffer.from('enc:' + JSON.stringify(credential), 'utf8')
  const record = {
    format: 'dshker.peer-credential',
    version: 1,
    ciphertext: ciphertext.toString('base64')
  }
  await writeFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
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

    it('keeps a pending enrollment on the legacy path with a port present', async () => {
      const { root, file, dispose } = await legacyRoot()
      cleanup = dispose
      const pending = {
        serviceId: credential.serviceId,
        requestId: 'e'.repeat(32),
        networkId: 'f'.repeat(32),
        userId: credential.userId,
        name: credential.name,
        publicKey: credential.publicKey,
        privateKey: credential.privateKey
      }
      const ciphertext = Buffer.from('enc:' + JSON.stringify(pending), 'utf8')
      await writeFile(
        file,
        JSON.stringify({
          format: 'dshker.peer-enrollment',
          version: 1,
          ciphertext: ciphertext.toString('base64')
        }) + '\n',
        { encoding: 'utf8', mode: 0o600 }
      )
      const secrets = fakeSecrets()
      const store = new PeerCredentialStore(root, secrets)
      const read = await store.loadRegistration(credential.serviceId)
      expect(read.kind).toBe('pending')
      expect(secrets.store.size).toBe(0)
    })
  }
)
