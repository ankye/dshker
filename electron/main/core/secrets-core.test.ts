import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerCredentialStore, type PeerCredential } from '../p2p/credentials'
import { CoreSecrets } from './secrets'
import { CoreSupervisor } from './supervisor'

// The legacy record is produced by the same code path the previous release
// used; the native provider behind the real dshkerd is the system one.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (bytes: Buffer) => bytes.toString('utf8').slice(4)
  }
}))

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

const target =
  process.platform === 'win32'
    ? process.arch === 'arm64'
      ? 'win32-arm64'
      : 'win32-x64'
    : process.arch === 'arm64'
      ? 'darwin-arm64'
      : 'darwin-x64'

function coreName(): string {
  return process.platform === 'win32' ? 'dshkerd.exe' : 'dshkerd'
}

async function realCoreBinary(): Promise<string | undefined> {
  if (process.env.DSHKER_CORE_BINARY) return process.env.DSHKER_CORE_BINARY
  const local = join(process.cwd(), 'build', 'p2p', target, coreName())
  const bytes = await readFile(local).catch(() => undefined)
  return bytes === undefined ? undefined : local
}

const binary = await realCoreBinary()

// Proves the upgrade story against the real dshkerd and the platform
// native provider: a legacy record migrates once, the credential survives
// a full core restart (two runs), and cleanup removes the stored secret.
describe.skipIf(binary === undefined)('core secret migration against a real dshkerd', () => {
  const cleanup: (() => Promise<void>)[] = []
  let supervisor: CoreSupervisor | undefined

  afterEach(async () => {
    await supervisor?.close().catch(() => undefined)
    supervisor = undefined
    for (const dispose of cleanup.splice(0)) await dispose()
  })

  async function harness() {
    const resourcesRoot = await mkdtemp(join(tmpdir(), 'core-res-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'core-data-'))
    const settings = await mkdtemp(join(tmpdir(), 'core-settings-'))
    cleanup.push(
      () => rm(resourcesRoot, { recursive: true, force: true }),
      () => rm(dataRoot, { recursive: true, force: true }),
      () => rm(settings, { recursive: true, force: true })
    )
    const directory = join(resourcesRoot, 'p2p', target)
    await mkdir(directory, { recursive: true })
    const bytes = await readFile(binary!)
    await copyFile(binary!, join(directory, coreName()))
    if (process.platform !== 'win32') await chmod(join(directory, coreName()), 0o755)
    const manifest = {
      version: 1,
      target,
      file: coreName(),
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    await writeFile(join(directory, 'dshkerd-manifest.json'), JSON.stringify(manifest) + '\n')
    const credentials = join(settings, 'dsh-launcher', 'p2p-credentials')
    await mkdir(credentials, { recursive: true })
    return { resourcesRoot, dataRoot, settings, credentials }
  }

  function start(meta: Awaited<ReturnType<typeof harness>>) {
    return CoreSupervisor.start(
      {
        resourcesRoot: meta.resourcesRoot,
        dataRoot: meta.dataRoot,
        onUnavailable: () => undefined
      },
      new AbortController().signal
    )
  }

  async function writeLegacyRecord(file: string) {
    const ciphertext = Buffer.from('enc:' + JSON.stringify(credential), 'utf8')
    await writeFile(
      file,
      JSON.stringify({
        format: 'dshker.peer-credential',
        version: 1,
        ciphertext: ciphertext.toString('base64')
      }) + '\n',
      { encoding: 'utf8', mode: 0o600 }
    )
  }

  it('migrates a legacy credential once and survives a core restart', async () => {
    const meta = await harness()
    const legacyFile = join(meta.credentials, credential.serviceId + '.json')
    await writeLegacyRecord(legacyFile)

    // Run one: the live core migrates the legacy record.
    supervisor = await start(meta)
    const first = new PeerCredentialStore(
      () => Promise.resolve(meta.settings),
      new CoreSecrets(supervisor.rpc)
    )
    const migrated = await first.loadRegistration(credential.serviceId)
    expect(migrated.kind).toBe('registered')
    await expect(readFile(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await supervisor.close()
    supervisor = undefined

    // Run two: a fresh core process answers from the persisted provider value.
    supervisor = await start(meta)
    const second = new PeerCredentialStore(
      () => Promise.resolve(meta.settings),
      new CoreSecrets(supervisor.rpc)
    )
    const read = await second.loadRegistration(credential.serviceId)
    expect(read.kind).toBe('registered')
    if (read.kind !== 'registered') return
    expect(read.credential.deviceId).toBe(credential.deviceId)
    expect(read.credential.privateKey).toBe(credential.privateKey)

    // Cleanup: the stored secret leaves the provider.
    const secrets = new CoreSecrets(supervisor.rpc)
    await secrets.delete('peer-credential:' + credential.serviceId)
    await expect(secrets.get('peer-credential:' + credential.serviceId)).resolves.toBeUndefined()
  })
})
