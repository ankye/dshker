import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerCatalog } from './catalog'
import { PeerServices } from './services'

const input = {
  displayName: 'Private server',
  httpsOrigin: 'https://example.test',
  wssUrl: 'wss://example.test/v1/signals',
  stunAddress: 'example.test:3478'
}
const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
const serviceId = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
// Public test-only CA, with no retained private key. The RPC double represents
// Go's signature verification, not proof of real server connectivity.
const certificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'
const identity = {
  version: 1,
  serviceId,
  publicKey,
  certificate,
  nonce: 'a'.repeat(32),
  httpsOrigin: input.httpsOrigin,
  wssUrl: input.wssUrl,
  stunAddress: input.stunAddress,
  signature: Buffer.alloc(64, 1).toString('base64url')
}
const roots: string[] = []
const signal = () => AbortSignal.timeout(5000)
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'peer-services-test-'))
  roots.push(root)
  await mkdir(join(root, 'dsh-launcher'))
  const catalog = new PeerCatalog(async () => root)
  const call = vi.fn<(method: string, value: unknown, signal: AbortSignal) => Promise<unknown>>()
  const services = new PeerServices(catalog, { call })
  return { catalog, call, services }
}

describe('saved P2P service admission', () => {
  it('requires explicit P2P enable before contacting a server', async () => {
    const { catalog, call, services } = await fixture()
    await expect(services.add('0'.repeat(64), input, signal())).rejects.toMatchObject({
      code: 'p2p.not_enabled'
    })
    expect(call).not.toHaveBeenCalled()
    expect(await catalog.inspect()).toBeUndefined()
  })

  it('persists the verified identity and activates a new owner with its exact pinned key', async () => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    call.mockResolvedValue(identity)
    const saved = await services.add(enabled.revision, input, signal())
    expect(saved.record.services).toEqual([{ ...input, serviceId, publicKey, certificate }])
    expect(await catalog.inspect()).toEqual(saved)
    expect(call.mock.calls[0][1]).toEqual({
      endpoints: {
        httpsOrigin: input.httpsOrigin,
        wssUrl: input.wssUrl,
        stunAddress: input.stunAddress
      },
      pinnedKey: ''
    })
    const restarted = new PeerServices(catalog, { call })
    expect(await restarted.activate(serviceId, signal())).toEqual(saved.record.services[0])
    expect(call.mock.calls[1][1]).toEqual({
      endpoints: {
        httpsOrigin: input.httpsOrigin,
        wssUrl: input.wssUrl,
        stunAddress: input.stunAddress
      },
      pinnedKey: publicKey
    })
    await restarted.activate(serviceId, signal())
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('rejects stale revisions before a network operation', async () => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    await expect(services.add('0'.repeat(64), input, signal())).rejects.toMatchObject({
      code: 'p2p.catalog_conflict'
    })
    expect(call).not.toHaveBeenCalled()
    expect(await catalog.inspect()).toEqual(enabled)
  })

  it.each([
    { version: 2 },
    { httpsOrigin: 'https://foreign.test' },
    { publicKey: Buffer.alloc(32).toString('base64') },
    { signature: 'bad' }
  ])('rejects malformed or substituted helper identity without publishing %j', async (patch) => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    call.mockResolvedValue({ ...identity, ...patch })
    await expect(services.add(enabled.revision, input, signal())).rejects.toThrow()
    expect(await catalog.inspect()).toEqual(enabled)
    await expect(services.requireSaved(serviceId)).rejects.toMatchObject({
      code: 'p2p.service_unconfigured'
    })
  })

  it('does not reuse an already configured helper after trust was forgotten', async () => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    call.mockResolvedValue(identity)
    const saved = await services.add(enabled.revision, input, signal())
    await catalog.commit(saved.revision, { ...saved.record, forgottenServiceIds: [serviceId] })
    call.mockClear()
    await expect(services.activate(serviceId, signal())).rejects.toMatchObject({
      code: 'p2p.trust_restore_rejected'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('does not restore a forgotten identity under a new address', async () => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    const blocked = await catalog.commit(enabled.revision, {
      ...enabled.record,
      forgottenServiceIds: [serviceId]
    })
    call.mockResolvedValue(identity)
    await expect(services.add(blocked.revision, input, signal())).rejects.toMatchObject({
      code: 'p2p.trust_restore_rejected'
    })
    expect(await catalog.inspect()).toEqual(blocked)
  })

  it('rejects caller-supplied credentials and cancels before any RPC', async () => {
    const { catalog, call, services } = await fixture()
    const enabled = await catalog.enable()
    const untrusted = { ...input, privateKey: 'forbidden' }
    await expect(services.add(enabled.revision, untrusted, signal())).rejects.toThrow()
    await expect(services.add(enabled.revision, input, AbortSignal.abort())).rejects.toMatchObject({
      code: 'p2p.request_cancelled'
    })
    expect(call).not.toHaveBeenCalled()
  })
})
