import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerCatalog } from '../p2p/catalog'
import type { PeerCatalogRecord } from '../p2p/catalog-schema'
import { CoreCatalog } from './catalog'
import { CoreSupervisor } from './supervisor'

const certificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'
const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
const serviceId = createHash('sha256')
  .update(Buffer.from(publicKey, 'base64'))
  .digest('hex')
  .slice(0, 12)

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

function paired(record: PeerCatalogRecord): PeerCatalogRecord {
  return {
    ...record,
    services: [
      {
        serviceId,
        displayName: 'Test server',
        httpsOrigin: 'https://example.test',
        wssUrl: 'wss://example.test/v1/signals',
        stunAddress: 'example.test:3478',
        publicKey,
        certificate
      }
    ],
    computers: [
      {
        connectionId: '1'.repeat(12),
        serviceId,
        displayName: 'Remote Mac',
        pairId: '2'.repeat(12),
        networkId: '3'.repeat(12),
        localDeviceId: '4'.repeat(12),
        remoteDeviceId: '5'.repeat(12),
        userId: '6'.repeat(12),
        localPublicKey: publicKey,
        remotePublicKey: Buffer.alloc(32, 2).toString('base64'),
        pairRevision: 1,
        pairState: 'active'
      }
    ]
  }
}

// Proves the upgrade story against the real dshkerd: a catalog the released
// shell wrote is adopted in place by the core with no migration step, every
// later mutation lands in the same file, and a build without a core still reads
// it — the two are never divergent writers.
describe.skipIf(binary === undefined)('catalog ownership against a real dshkerd', () => {
  const cleanup: (() => Promise<void>)[] = []
  let supervisor: CoreSupervisor | undefined

  afterEach(async () => {
    await supervisor?.close().catch(() => undefined)
    supervisor = undefined
    for (const dispose of cleanup.splice(0)) await dispose()
  })

  async function harness() {
    const resourcesRoot = await mkdtemp(join(tmpdir(), 'core-cat-res-'))
    const dataRoot = await mkdtemp(join(tmpdir(), 'core-cat-data-'))
    const settings = await mkdtemp(join(tmpdir(), 'core-cat-settings-'))
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
    const catalogRoot = join(settings, 'dsh-launcher')
    await mkdir(catalogRoot, { recursive: true })
    return { resourcesRoot, dataRoot, settings, catalogRoot }
  }

  function start(meta: Awaited<ReturnType<typeof harness>>) {
    return CoreSupervisor.start(
      {
        resourcesRoot: meta.resourcesRoot,
        dataRoot: meta.dataRoot,
        stateRoot: join(meta.dataRoot, 'state'),
        catalogRoot: meta.catalogRoot,
        onUnavailable: () => undefined
      },
      new AbortController().signal
    )
  }

  it('adopts the record the shell already wrote and keeps owning it', async () => {
    const meta = await harness()
    const file = join(meta.catalogRoot, 'p2p-devices.json')
    // The released shell's writer, used exactly as the previous version used it.
    const legacy = new PeerCatalog(() => Promise.resolve(meta.settings))
    const enabled = await legacy.enable()
    const saved = await legacy.commit(enabled.revision, paired(enabled.record))
    const before = await readFile(file, 'utf8')

    supervisor = await start(meta)
    const routed = new PeerCatalog(
      () => Promise.resolve(meta.settings),
      new CoreCatalog(supervisor.rpc)
    )

    // The core itself — no fallback in this call — reads the same file with the
    // same revision, so the adoption is real and not the shell's own reader.
    await expect(new CoreCatalog(supervisor.rpc).inspect()).resolves.toEqual(saved)
    await expect(routed.inspect()).resolves.toEqual(saved)
    await expect(readFile(file, 'utf8')).resolves.toBe(before)

    // A mutation that goes through the core lands in that same file.
    const computer = saved.record.computers[0]!
    const revoked = await routed.commit(saved.revision, {
      ...saved.record,
      computers: [{ ...computer, pairRevision: 2, pairState: 'revoked' }]
    })
    expect(revoked.record.computers[0]?.pairState).toBe('revoked')
    await expect(readFile(file, 'utf8')).resolves.toBe(JSON.stringify(revoked.record))

    // A build with no core reads what the core wrote, and the revision is still
    // the sha256 of the bytes on disk.
    const readBack = await legacy.inspect()
    expect(readBack?.record).toEqual(revoked.record)
    await expect(readBack?.revision).toBe(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex')
    )

    // Revoked, so the removal the workflow performs next is allowed.
    const removed = await routed.removeService(serviceId)
    expect(removed.record.services).toEqual([])
    expect(removed.record.forgottenServiceIds).toEqual([serviceId])
    expect((await legacy.inspect())?.record).toEqual(removed.record)

    // A fresh core process answers from the file the previous one published.
    await supervisor.close()
    supervisor = await start(meta)
    const restarted = new PeerCatalog(
      () => Promise.resolve(meta.settings),
      new CoreCatalog(supervisor.rpc)
    )
    await expect(restarted.inspect()).resolves.toEqual(removed)
  })

  it('enables an empty catalog through the core and refuses a second enable', async () => {
    const meta = await harness()
    supervisor = await start(meta)
    const routed = new PeerCatalog(
      () => Promise.resolve(meta.settings),
      new CoreCatalog(supervisor.rpc)
    )
    await expect(routed.inspect()).resolves.toBeUndefined()
    await expect(new CoreCatalog(supervisor.rpc).inspect()).resolves.toBeUndefined()
    const created = await routed.enable()
    expect(created.record.catalogId).toHaveLength(12)
    expect(created.record.computers).toEqual([])
    await expect(routed.enable()).rejects.toMatchObject({ code: 'p2p.catalog_exists' })
    // The shell's own reader sees exactly what the core published.
    const legacy = new PeerCatalog(() => Promise.resolve(meta.settings))
    await expect(legacy.inspect()).resolves.toEqual(created)
  })
})
