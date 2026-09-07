import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerCatalog } from './catalog'
import { assertPeerEndpoints, parsePeerCatalog, type PeerCatalogRecord } from './catalog-schema'

const roots: string[] = []
// Public test-only CA; its disposable private key was never stored. Catalog
// continuity is independent of certificate time; live authentication checks expiry.
const serviceCertificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dshker-catalog-test-'))
  roots.push(root)
  const parent = join(root, 'dsh-launcher')
  await mkdir(parent)
  return { root, parent, catalog: new PeerCatalog(async () => root) }
}

function paired(record: PeerCatalogRecord): PeerCatalogRecord {
  const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
  const serviceId = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
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
        certificate: serviceCertificate
      }
    ],
    computers: [
      {
        connectionId: '1'.repeat(32),
        serviceId,
        displayName: 'Remote Mac',
        pairId: '2'.repeat(32),
        networkId: '3'.repeat(32),
        localDeviceId: '4'.repeat(32),
        remoteDeviceId: '5'.repeat(32),
        userId: '6'.repeat(32),
        localPublicKey: publicKey,
        remotePublicKey: Buffer.alloc(32, 2).toString('base64'),
        pairRevision: 1,
        pairState: 'active'
      }
    ]
  }
}

describe('registered P2P catalog', () => {
  it.each([
    'not-a-certificate',
    serviceCertificate + '\n',
    Buffer.from('wrong').toString('base64')
  ])('rejects malformed service certificates', async (certificate) => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    const next = paired(enabled.record)
    next.services[0].certificate = certificate
    expect(() => catalog.commit(enabled.revision, next)).toThrow()
    expect(await catalog.inspect()).toEqual(enabled)
  })

  it('rejects a CA whose actual key does not match the pinned service', async () => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    const next = paired(enabled.record)
    const bytes = Buffer.alloc(32, 9)
    next.services[0].publicKey = bytes.toString('base64')
    next.services[0].serviceId = createHash('sha256').update(bytes).digest('hex')
    next.computers[0].serviceId = next.services[0].serviceId
    expect(() => catalog.commit(enabled.revision, next)).toThrow()
    expect(await catalog.inspect()).toEqual(enabled)
  })
  it('requires explicit enable, survives a new owner, and never changes SSH bytes', async () => {
    const { root, parent, catalog } = await fixture()
    const sshPath = join(parent, 'remote-connections.json')
    const sshBytes = '{"version":1,"connections":[]}'
    await writeFile(sshPath, sshBytes)
    expect(await catalog.inspect()).toBeUndefined()
    const enabled = await catalog.enable()
    expect(await new PeerCatalog(async () => root).inspect()).toEqual(enabled)
    await expect(catalog.enable()).rejects.toMatchObject({ code: 'p2p.catalog_exists' })
    expect(await readFile(sshPath, 'utf8')).toBe(sshBytes)
    const file = join(parent, 'p2p-devices.json')
    const before = await stat(file)
    expect(await catalog.commit(enabled.revision, enabled.record)).toEqual(enabled)
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  it.each(['p2p-devices.json', 'p2p-enabled.json'])(
    'does not recreate missing %s',
    async (name) => {
      const { parent, catalog } = await fixture()
      await catalog.enable()
      await unlink(join(parent, name))
      await expect(catalog.inspect()).rejects.toMatchObject({ code: 'p2p.catalog_incomplete' })
      await expect(catalog.enable()).rejects.toMatchObject({ code: 'p2p.catalog_exists' })
      await expect(stat(join(parent, name))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects a substituted marker without changing either record', async () => {
    const { parent, catalog } = await fixture()
    const enabled = await catalog.enable()
    const marker = JSON.stringify({ version: 1, catalogId: 'f'.repeat(32) })
    await writeFile(join(parent, 'p2p-enabled.json'), marker)
    await expect(catalog.inspect()).rejects.toMatchObject({ code: 'p2p.catalog_invalid' })
    expect(await readFile(join(parent, 'p2p-enabled.json'), 'utf8')).toBe(marker)
    expect(JSON.parse(await readFile(join(parent, 'p2p-devices.json'), 'utf8'))).toEqual(
      enabled.record
    )
  })

  it('rejects missing registered roots and symbolic-link records', async () => {
    const { root, parent, catalog } = await fixture()
    await expect(new PeerCatalog(async () => 'relative').inspect()).rejects.toMatchObject({
      code: 'p2p.settings_root_required'
    })
    const enabled = await catalog.enable()
    const target = join(root, 'outside.json')
    await writeFile(target, JSON.stringify(enabled.record))
    await unlink(join(parent, 'p2p-devices.json'))
    await symlink(target, join(parent, 'p2p-devices.json'))
    await expect(catalog.inspect()).rejects.toMatchObject({ code: 'p2p.catalog_invalid' })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(enabled.record)
  })

  it('serializes concurrent revisions and snapshots queued inputs', async () => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    const next = paired(enabled.record)
    const first = catalog.commit(enabled.revision, next)
    next.computers[0].displayName = 'mutated after enqueue'
    const second = catalog.commit(enabled.revision, next)
    const rejected = expect(second).rejects.toMatchObject({ code: 'p2p.catalog_conflict' })
    const saved = await first
    await rejected
    expect(saved.record.computers[0].displayName).toBe('Remote Mac')
    expect(await catalog.inspect()).toEqual(saved)
  })

  it.each(['pairId', 'networkId', 'localDeviceId', 'remoteDeviceId', 'userId'] as const)(
    'rejects editing %s without partial writes',
    async (field) => {
      const { catalog } = await fixture()
      const enabled = await catalog.enable()
      const saved = await catalog.commit(enabled.revision, paired(enabled.record))
      const next = structuredClone(saved.record)
      next.computers[0][field] = 'a'.repeat(32)
      next.computers[0].displayName = 'must not persist'
      await expect(catalog.commit(saved.revision, next)).rejects.toMatchObject({
        code: 'p2p.identity_mismatch'
      })
      expect(await catalog.inspect()).toEqual(saved)
    }
  )

  it('persists rename and revocation, rejects restoration, and removes only revoked records', async () => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    const saved = await catalog.commit(enabled.revision, paired(enabled.record))
    await expect(
      catalog.commit(saved.revision, { ...saved.record, computers: [] })
    ).rejects.toMatchObject({ code: 'p2p.revocation_required' })
    const next = structuredClone(saved.record)
    next.computers[0].displayName = '远程电脑'
    next.computers[0].pairState = 'revoked'
    next.computers[0].pairRevision = 2
    const revoked = await catalog.commit(saved.revision, next)
    expect((await catalog.inspect())?.record.computers[0]).toEqual(next.computers[0])
    await expect(catalog.commit(revoked.revision, saved.record)).rejects.toMatchObject({
      code: 'p2p.trust_restore_rejected'
    })
    const removed = await catalog.commit(revoked.revision, { ...revoked.record, computers: [] })
    expect(removed.record.services).toEqual(saved.record.services)
    expect(removed.record.computers).toEqual([])
  })

  it('requires a durable tombstone before service removal and cannot reintroduce forgotten trust', async () => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    const saved = await catalog.commit(enabled.revision, paired(enabled.record))
    const serviceId = saved.record.services[0].serviceId
    const erased = {
      ...saved.record,
      services: [],
      computers: [],
      forgottenServiceIds: [serviceId]
    }
    await expect(catalog.commit(saved.revision, erased)).rejects.toMatchObject({
      code: 'p2p.forget_required'
    })
    const blocked = await catalog.commit(saved.revision, {
      ...saved.record,
      forgottenServiceIds: [serviceId]
    })
    const removed = await catalog.commit(blocked.revision, erased)
    await expect(
      catalog.commit(removed.revision, { ...saved.record, forgottenServiceIds: [serviceId] })
    ).rejects.toMatchObject({ code: 'p2p.trust_restore_rejected' })
    await expect(catalog.commit(removed.revision, enabled.record)).rejects.toMatchObject({
      code: 'p2p.trust_restore_rejected'
    })
    expect(await catalog.inspect()).toEqual(removed)
  })

  it.each([
    { version: 2 },
    { extra: true },
    { computers: [{}] },
    { services: [{}] },
    { forgottenServiceIds: ['bad'] }
  ])('rejects malformed schema %j', async (patch) => {
    const { catalog } = await fixture()
    const enabled = await catalog.enable()
    expect(() => parsePeerCatalog(JSON.stringify({ ...enabled.record, ...patch }))).toThrow()
    expect(await catalog.inspect()).toEqual(enabled)
  })

  it.each([
    ['https://example.test/', 'wss://example.test/v1/signals', 'example.test:3478'],
    ['https://example.test', 'wss://elsewhere.test/v1/signals', 'example.test:3478'],
    ['https://example.test', 'wss://example.test/other/../v1/signals', 'example.test:3478'],
    ['https://example.test', 'wss://example.test/v1/signals', 'example.test:0'],
    ['https://example.test', 'wss://example.test/v1/signals', 'example.test:03478']
  ])('rejects endpoint normalization or mismatched authority: %s %s %s', (https, wss, stun) => {
    expect(() => assertPeerEndpoints(https, wss, stun)).toThrow()
  })
})
