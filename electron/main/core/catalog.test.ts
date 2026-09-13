import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parsePeerCatalog, type PeerCatalogRecord } from '../p2p/catalog-schema'
import { PeerHelperError } from '../p2p/wire'
import { CoreCatalog } from './catalog'

// Public test-only CA, shared with the shell-side catalog fixtures; its
// disposable private key was never stored.
const certificate =
  'MIIBTDCB/6ADAgECAhQdvAzm/JylryF76uUuO7r+d071FzAFBgMrZXAwHDEaMBgGA1UEAwwRY2F0YWxvZy10ZXN0LW9ubHkwHhcNMjYwOTA3MDkzNDI0WhcNMjYwOTA4MDkzNDI0WjAcMRowGAYDVQQDDBFjYXRhbG9nLXRlc3Qtb25seTAqMAUGAytlcAMhAHZKq/+rjwt8Xbk/r6Ndl2OZJq3kO0qPI4m6QdmyBHh8o1MwUTAdBgNVHQ4EFgQUTzBnYBq4Sj67YKEwfjV4RQprqugwHwYDVR0jBBgwFoAUTzBnYBq4Sj67YKEwfjV4RQprqugwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCBoRFNNIoG4H5nDknITd+qNkK1U0YinUt0fnoMS8dSZ+u7rI1uCjuNRSiTLZ4nnspeqawDqAFFtrJcV4GNHBIM'
const publicKey = 'dkqr/6uPC3xduT+vo12XY5kmreQ7So8jibpB2bIEeHw='
const serviceId = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')

function record(): PeerCatalogRecord {
  return {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: 'a'.repeat(32),
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
    computers: [],
    forgottenServiceIds: []
  }
}

const revision = 'b'.repeat(64)

function fakeRpc(answer: (method: string, payload: unknown) => unknown) {
  const calls: { method: string; payload: unknown }[] = []
  return {
    calls,
    call: (method: string, payload: unknown): Promise<unknown> => {
      calls.push({ method, payload })
      return Promise.resolve(answer(method, payload))
    }
  }
}

function serving(value: unknown) {
  return fakeRpc(() => value)
}

describe('core catalog client', () => {
  it('reads a never-enabled catalog as an absent one, not a failure', async () => {
    const rpc = serving({ enabled: false })
    await expect(new CoreCatalog(rpc).inspect()).resolves.toBeUndefined()
    expect(rpc.calls).toEqual([{ method: 'core.catalog_inspect', payload: {} }])
  })

  it('projects an enabled answer through the shell validator unchanged', async () => {
    const rpc = serving({ enabled: true, revision, record: record() })
    const snapshot = await new CoreCatalog(rpc).inspect()
    expect(snapshot).toEqual({ revision, record: record() })
  })

  it('refuses an enabled answer whose record no longer validates', async () => {
    const broken = { ...record(), catalogId: 'not-hex' }
    const rpc = serving({ enabled: true, revision, record: broken })
    await expect(new CoreCatalog(rpc).inspect()).rejects.toMatchObject({
      code: 'p2p.catalog_invalid'
    })
  })

  it.each([
    ['a non-boolean enabled flag', { enabled: 'yes' }],
    ['a missing record', { enabled: true, revision }],
    ['a revision that is not a sha256', { enabled: true, revision: 'short', record: record() }]
  ])('refuses %s as an invalid projection', async (_name, answer) => {
    await expect(new CoreCatalog(serving(answer)).inspect()).rejects.toMatchObject({
      code: 'p2p.invalid_payload'
    })
  })

  it('enables through the core and never invents an enabled answer', async () => {
    const rpc = serving({ enabled: true, revision, record: record() })
    await expect(new CoreCatalog(rpc).enable()).resolves.toEqual({ revision, record: record() })
    expect(rpc.calls).toEqual([{ method: 'core.catalog_enable', payload: {} }])
    await expect(new CoreCatalog(serving({ enabled: false })).enable()).rejects.toMatchObject({
      code: 'p2p.catalog_invalid'
    })
  })

  it('passes the record through on commit exactly as the store expects it', async () => {
    const rpc = serving({ enabled: true, revision, record: record() })
    const next = { ...record(), forgottenServiceIds: [] }
    await new CoreCatalog(rpc).commit(revision, next)
    expect(rpc.calls).toEqual([
      { method: 'core.catalog_commit', payload: { expectedRevision: revision, record: next } }
    ])
  })

  it('removes one service by id and surfaces the store refusal', async () => {
    const calls: string[] = []
    const rpc = fakeRpc((method) => {
      calls.push(method)
      throw new PeerHelperError('p2p.service_not_found')
    })
    await expect(new CoreCatalog(rpc).removeService(serviceId)).rejects.toMatchObject({
      code: 'p2p.service_not_found'
    })
    expect(calls).toEqual(['core.catalog_remove_service'])
  })

  it('keeps the record parseable for callers that re-read a core answer', async () => {
    const rpc = serving({ enabled: true, revision, record: record() })
    const snapshot = await new CoreCatalog(rpc).inspect()
    expect(parsePeerCatalog(JSON.stringify(snapshot?.record))).toEqual(record())
  })
})
