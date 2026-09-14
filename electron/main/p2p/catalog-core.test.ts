import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreCatalogPort } from '../core/catalog'
import { PeerCatalog } from './catalog'
import type { PeerCatalogRecord, PeerCatalogSnapshot } from './catalog-schema'
import { PeerHelperError } from './wire'

const certificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'
const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
const serviceId = createHash('sha256')
  .update(Buffer.from(publicKey, 'base64'))
  .digest('hex')
  .slice(0, 12)

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A settings root with the shell's own catalog file already on disk. */
async function legacyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dshker-catalog-route-'))
  roots.push(root)
  const parent = join(root, 'dsh-launcher')
  await mkdir(parent)
  const legacy = new PeerCatalog(async () => root)
  const enabled = await legacy.enable()
  const saved = await legacy.commit(enabled.revision, paired(enabled.record))
  return { root, parent, legacy, saved }
}

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

/** One in-memory core catalog; every call is recorded so routing is observable. */
class FakeCore implements CoreCatalogPort {
  readonly calls: string[] = []
  snapshot: PeerCatalogSnapshot | undefined
  failure: PeerHelperError | undefined

  async inspect(): Promise<PeerCatalogSnapshot | undefined> {
    return this.#answer(this.snapshot)
  }

  async enable(): Promise<PeerCatalogSnapshot> {
    const answer = this.#answer(this.snapshot)
    if (answer === undefined) throw new PeerHelperError('p2p.catalog_invalid')
    return answer
  }

  async commit(expectedRevision: string, next: PeerCatalogRecord): Promise<PeerCatalogSnapshot> {
    const answer = this.#answer({ revision: expectedRevision, record: next })
    this.snapshot = answer
    return answer
  }

  async removeService(target: string): Promise<PeerCatalogSnapshot> {
    if (this.snapshot === undefined) throw new PeerHelperError('p2p.catalog_invalid')
    const record = this.snapshot.record
    return this.#answer({
      revision: 'e'.repeat(64),
      record: {
        ...record,
        services: record.services.filter((value) => value.serviceId !== target),
        computers: record.computers.filter((value) => value.serviceId !== target),
        forgottenServiceIds: [...record.forgottenServiceIds, target]
      }
    })
  }

  #answer<T>(value: T): T {
    this.calls.push('core')
    if (this.failure) throw this.failure
    return value
  }
}

describe('catalog routing through the core', () => {
  it('reads the core and never touches the file the shell used to own', async () => {
    const { root, parent, saved } = await legacyFixture()
    const file = join(parent, 'p2p-devices.json')
    const before = await readFile(file, 'utf8')
    const core = new FakeCore()
    core.snapshot = { revision: 'c'.repeat(64), record: { ...saved.record, computers: [] } }

    const routed = new PeerCatalog(async () => root, core)
    await expect(routed.inspect()).resolves.toEqual(core.snapshot)
    expect(core.calls).toHaveLength(1)
    await expect(readFile(file, 'utf8')).resolves.toBe(before)
  })

  it('treats the core never-enabled answer as authoritative', async () => {
    const { root } = await legacyFixture()
    const core = new FakeCore()
    const routed = new PeerCatalog(async () => root, core)
    // The core owns the file now, so its answer stands even though the shell
    // can still see bytes on disk.
    await expect(routed.inspect()).resolves.toBeUndefined()
    expect(core.calls).toHaveLength(1)
  })

  it.each(['p2p.not_implemented', 'p2p.catalog_unavailable', 'p2p.invalid_operation'])(
    'falls back to the file once when the core answers %s',
    async (code) => {
      const { root, saved } = await legacyFixture()
      const core = new FakeCore()
      core.failure = new PeerHelperError(code)
      const routed = new PeerCatalog(async () => root, core)
      await expect(routed.inspect()).resolves.toEqual(saved)
      await expect(routed.inspect()).resolves.toEqual(saved)
      expect(core.calls).toHaveLength(1)
    }
  )

  it('propagates a transport failure instead of becoming a second writer', async () => {
    const { root, parent, saved } = await legacyFixture()
    const file = join(parent, 'p2p-devices.json')
    const before = await readFile(file, 'utf8')
    const core = new FakeCore()
    core.failure = new PeerHelperError('p2p.helper_unavailable')
    const routed = new PeerCatalog(async () => root, core)

    await expect(routed.inspect()).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    await expect(routed.inspect()).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    expect(core.calls).toHaveLength(2)
    await expect(readFile(file, 'utf8')).resolves.toBe(before)
    expect(saved.revision).toHaveLength(64)
  })

  it('validates a commit before it reaches the core', async () => {
    const { root, saved } = await legacyFixture()
    const core = new FakeCore()
    const routed = new PeerCatalog(async () => root, core)
    expect(() => routed.commit(saved.revision, { ...saved.record, catalogId: 'nope' })).toThrow()
    expect(core.calls).toEqual([])
  })

  it('routes enable, commit and remove through the core', async () => {
    const { root, saved } = await legacyFixture()
    const core = new FakeCore()
    core.snapshot = saved
    const routed = new PeerCatalog(async () => root, core)

    await expect(routed.enable()).resolves.toEqual(saved)
    const committed = await routed.commit(saved.revision, {
      ...saved.record,
      forgottenServiceIds: []
    })
    expect(committed.record.catalogId).toBe(saved.record.catalogId)
    const removed = await routed.removeService(serviceId)
    expect(removed.record.services).toEqual([])
    expect(removed.record.forgottenServiceIds).toEqual([serviceId])
    expect(core.calls).toHaveLength(3)
  })

  it('writes the file itself only after the core proves it has no catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshker-catalog-degrade-'))
    roots.push(root)
    await mkdir(join(root, 'dsh-launcher'))
    const core = new FakeCore()
    core.failure = new PeerHelperError('p2p.catalog_unavailable')
    const routed = new PeerCatalog(async () => root, core)

    await expect(routed.inspect()).resolves.toBeUndefined()
    await expect(routed.enable()).resolves.toBeDefined()
    expect(core.calls).toHaveLength(1)
    const file = JSON.parse(
      await readFile(join(root, 'dsh-launcher', 'p2p-devices.json'), 'utf8')
    ) as PeerCatalogRecord
    expect(file.format).toBe('dshker.p2p-devices')
  })
})
