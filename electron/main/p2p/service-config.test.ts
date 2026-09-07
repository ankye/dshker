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
const moved = {
  displayName: 'Private server',
  httpsOrigin: 'https://moved.test',
  wssUrl: 'wss://moved.test/v1/signals',
  stunAddress: 'moved.test:3478'
}
const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
const serviceId = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
const certificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'

function identityFor(fields: typeof input, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    serviceId,
    publicKey,
    certificate,
    nonce: 'a'.repeat(32),
    httpsOrigin: fields.httpsOrigin,
    wssUrl: fields.wssUrl,
    stunAddress: fields.stunAddress,
    signature: Buffer.alloc(64, 1).toString('base64url'),
    ...overrides
  }
}

const roots: string[] = []
const signal = () => AbortSignal.timeout(5000)
const idle = () => false

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A saved service plus one paired computer that shares its configuration. */
async function saved() {
  const root = await mkdtemp(join(tmpdir(), 'peer-config-test-'))
  roots.push(root)
  await mkdir(join(root, 'dsh-launcher'))
  const catalog = new PeerCatalog(async () => root)
  const call = vi.fn<(method: string, value: unknown, signal: AbortSignal) => Promise<unknown>>()
  const services = new PeerServices(catalog, { call })
  const enabled = await catalog.enable()
  call.mockResolvedValue(identityFor(input))
  const withService = await services.add(enabled.revision, input, signal())
  const withComputer = await catalog.commit(withService.revision, {
    ...withService.record,
    computers: [
      {
        connectionId: 'c'.repeat(32),
        serviceId,
        displayName: 'Studio',
        pairId: '1'.repeat(32),
        networkId: '2'.repeat(32),
        localDeviceId: '3'.repeat(32),
        remoteDeviceId: '4'.repeat(32),
        userId: '5'.repeat(32),
        localPublicKey: publicKey,
        remotePublicKey: Buffer.alloc(32, 3).toString('base64'),
        pairRevision: 1,
        pairState: 'active' as const
      }
    ]
  })
  call.mockReset()
  return { catalog, call, services, snapshot: withComputer }
}

describe('shared P2P service configuration', () => {
  it('saves a new address that still proves the same pinned identity', async () => {
    const f = await saved()
    f.call.mockResolvedValue(identityFor(moved))
    const result = await f.services.updateConfig(
      f.snapshot.revision,
      serviceId,
      moved,
      idle,
      signal()
    )
    expect(result.record.services[0]).toEqual({
      ...moved,
      serviceId,
      publicKey,
      certificate
    })
    // The pinned key is supplied so the server cannot present a new identity.
    expect(f.call.mock.calls[0]?.[1]).toMatchObject({ pinnedKey: publicKey })
  })

  it('refuses an endpoint that resolves to a different service identity', async () => {
    const f = await saved()
    const otherKey = Buffer.alloc(32, 9).toString('base64')
    f.call.mockResolvedValue(
      identityFor(moved, {
        publicKey: otherKey,
        serviceId: createHash('sha256').update(Buffer.from(otherKey, 'base64')).digest('hex')
      })
    )
    // Refused either as a mismatched identity or as an invalid record; what
    // matters is that a different identity is never accepted.
    await expect(
      f.services.updateConfig(f.snapshot.revision, serviceId, moved, idle, signal())
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^p2p\.(identity_mismatch|catalog_invalid)$/)
    })
    // The stored configuration is untouched.
    expect((await f.catalog.inspect())?.record.services[0]?.httpsOrigin).toBe(input.httpsOrigin)
  })

  it('refuses the update while any computer sharing the service is busy', async () => {
    const f = await saved()
    f.call.mockResolvedValue(identityFor(moved))
    await expect(
      f.services.updateConfig(
        f.snapshot.revision,
        serviceId,
        moved,
        (connectionId) => connectionId === 'c'.repeat(32),
        signal()
      )
    ).rejects.toMatchObject({ code: 'p2p.service_busy' })
    // Nothing was sent to the server and nothing was written.
    expect(f.call).not.toHaveBeenCalled()
    expect((await f.catalog.inspect())?.record.services[0]?.httpsOrigin).toBe(input.httpsOrigin)
  })

  it('rejects a stale catalog revision without contacting the server', async () => {
    const f = await saved()
    await expect(
      f.services.updateConfig('0'.repeat(64), serviceId, moved, idle, signal())
    ).rejects.toMatchObject({ code: 'p2p.catalog_conflict' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('rejects an unknown service instead of creating one', async () => {
    const f = await saved()
    await expect(
      f.services.updateConfig(f.snapshot.revision, 'b'.repeat(64), moved, idle, signal())
    ).rejects.toMatchObject({ code: 'p2p.service_not_found' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('keeps the original configuration when the server call fails', async () => {
    const f = await saved()
    f.call.mockRejectedValue(new Error('unreachable'))
    await expect(
      f.services.updateConfig(f.snapshot.revision, serviceId, moved, idle, signal())
    ).rejects.toThrow()
    const after = await f.catalog.inspect()
    expect(after?.record.services[0]?.httpsOrigin).toBe(input.httpsOrigin)
    expect(after?.record.services[0]?.wssUrl).toBe(input.wssUrl)
  })

  it('does not disturb the paired computer records', async () => {
    const f = await saved()
    f.call.mockResolvedValue(identityFor(moved))
    const result = await f.services.updateConfig(
      f.snapshot.revision,
      serviceId,
      moved,
      idle,
      signal()
    )
    expect(result.record.computers).toEqual(f.snapshot.record.computers)
  })

  it('refuses an endpoint whose reply changes the pinned public key', async () => {
    const f = await saved()
    // Same serviceId claimed, but a different key: this must never be re-trusted.
    f.call.mockResolvedValue(
      identityFor(moved, { publicKey: Buffer.alloc(32, 7).toString('base64') })
    )
    await expect(
      f.services.updateConfig(f.snapshot.revision, serviceId, moved, idle, signal())
    ).rejects.toThrow()
    expect((await f.catalog.inspect())?.record.services[0]?.publicKey).toBe(publicKey)
  })

  it('leaves a forgotten service permanently refused', async () => {
    const f = await saved()
    const forgotten = await f.catalog.commit(f.snapshot.revision, {
      ...f.snapshot.record,
      forgottenServiceIds: [serviceId]
    })
    await expect(
      f.services.updateConfig(forgotten.revision, serviceId, moved, idle, signal())
    ).rejects.toMatchObject({ code: 'p2p.trust_restore_rejected' })
    expect(f.call).not.toHaveBeenCalled()
  })
})
