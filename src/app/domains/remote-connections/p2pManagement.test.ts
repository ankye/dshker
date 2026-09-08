import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi, P2PCatalogView } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'

const saved: P2PCatalogView = {
  revision: 'revision',
  catalogId: 'catalog',
  services: [],
  computers: [],
  forgottenServiceIds: []
}
const service = {
  displayName: 'Home',
  httpsOrigin: 'https://peer.example',
  wssUrl: 'wss://peer.example/v1/signals',
  stunAddress: 'peer.example:3478'
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(overrides: Partial<P2PManagementApi> = {}) {
  const api = {
    catalog: vi.fn(async () => ({ ok: true, data: saved })),
    ...overrides
  } as unknown as P2PManagementApi
  return { api, domain: new P2PManagementDomain(() => api) }
}

describe('P2P management renderer owner', () => {
  it('keeps missing bridge, failed reads and explicitly not enabled distinct', async () => {
    const missing = new P2PManagementDomain(() => undefined)
    await missing.readCatalog()
    expect(missing.catalog.value).toBeUndefined()
    expect(missing.operations.catalog.error).toBe('bridge')
    const { domain, api } = setup({
      catalog: vi.fn(async () => ({ ok: true as const, data: null }))
    })
    await domain.readCatalog()
    expect(domain.catalog.value).toBeNull()
    vi.mocked(api.catalog).mockResolvedValueOnce({
      ok: false,
      code: 'p2p.catalog_invalid',
      message: 'p2p.catalog_invalid'
    })
    await domain.readCatalog()
    expect(domain.catalog.value).toBeNull()
    expect(domain.operations.catalog.error).toBe('p2p.catalog_invalid')
  })

  it('uses one monotonic document sequence across owner instances and methods', async () => {
    const { api, domain } = setup()
    await domain.readCatalog()
    const before = vi.mocked(api.catalog).mock.calls[0][0]
    await new P2PManagementDomain(() => api).readCatalog()
    const after = vi.mocked(api.catalog).mock.calls[1][0]
    expect(before.version).toBe(1)
    expect(after.requestId).toBeGreaterThan(before.requestId)
  })

  it('locks only the same service and never stores login credentials in state', async () => {
    const wait = deferred<{ ok: true; data: { userId: string; username: string } }>()
    const login = vi.fn(() => wait.promise)
    const { domain } = setup({ login })
    const input = { serviceId: 'one', username: 'alice', password: 'secret' }
    const first = domain.run('login', input)
    input.password = 'mutated'
    expect(login.mock.calls[0]).toBeDefined()
    expect(await domain.run('currentUser', { serviceId: 'one' })).toMatchObject({
      ok: false,
      code: 'p2p.service_busy'
    })
    const second = domain.run('login', {
      serviceId: 'two',
      username: 'bob',
      password: 'other secret'
    })
    expect(login).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenNthCalledWith(1, expect.objectContaining({ password: 'secret' }))
    expect(JSON.stringify(domain.operations)).not.toContain('secret')
    wait.resolve({ ok: true, data: { userId: 'user', username: 'alice' } })
    await Promise.all([first, second])
    expect(domain.operations.one.phase).toBe('succeeded')
    expect(domain.operations.two.phase).toBe('succeeded')
  })

  it('retains the pending slot until the original cancelled write settles', async () => {
    const wait = deferred<{
      ok: false
      code: 'p2p.management_result_unconfirmed'
      message: string
    }>()
    const cancel = vi.fn(async () => ({ ok: true as const, data: { accepted: true } }))
    const { domain } = setup({ deleteNetwork: () => wait.promise, cancel })
    const operation = domain.run('deleteNetwork', { serviceId: 'one', networkId: 'net' })
    const target = domain.operations.one.requestId
    await domain.cancel('one')
    expect(domain.operations.one.phase).toBe('cancelling')
    expect(domain.busy('one')).toBe(true)
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ targetRequestId: target }))
    wait.resolve({ ok: false, code: 'p2p.management_result_unconfirmed', message: 'unconfirmed' })
    await operation
    expect(domain.operations.one).toMatchObject({
      phase: 'failed',
      error: 'p2p.management_result_unconfirmed'
    })
    expect(domain.busy('one')).toBe(false)
  })

  it('does not let a late cancel failure replace a newer successful read', async () => {
    const original = deferred<{ ok: true; data: P2PCatalogView }>()
    const cancel = deferred<{ ok: false; code: 'p2p.request_unavailable'; message: string }>()
    const { domain, api } = setup({
      catalog: vi.fn(() => original.promise),
      cancel: () => cancel.promise
    })
    const read = domain.readCatalog()
    const cancellation = domain.cancel('catalog')
    original.resolve({ ok: true, data: saved })
    await read
    vi.mocked(api.catalog).mockResolvedValueOnce({ ok: true, data: { ...saved, revision: 'new' } })
    await domain.readCatalog()
    cancel.resolve({ ok: false, code: 'p2p.request_unavailable', message: 'late' })
    await cancellation
    expect(domain.operations.catalog.phase).toBe('succeeded')
    expect(domain.operations.catalog.cancelError).toBeUndefined()
    expect(domain.catalog.value?.revision).toBe('new')
  })

  it('reports transport-lost writes as unconfirmed without retry and preserves drafts', async () => {
    const addService = vi.fn(async () => {
      throw new Error('native transport lost')
    })
    const { domain } = setup({ addService })
    domain.catalog.value = saved
    Object.assign(domain.serviceDraft, service)
    await domain.addService()
    expect(domain.operations.catalog.error).toBe('unconfirmed')
    expect(domain.serviceDraft).toEqual(service)
    expect(domain.catalog.value).toEqual(saved)
    expect(addService).toHaveBeenCalledTimes(1)
  })

  it('commits the actual service readback and never erases a newly edited draft', async () => {
    const wait = deferred<{ ok: true; data: P2PCatalogView }>()
    const addService = vi.fn(() => wait.promise)
    const { domain } = setup({ addService })
    domain.catalog.value = saved
    Object.assign(domain.serviceDraft, service)
    const operation = domain.addService()
    domain.serviceDraft.displayName = 'Next service'
    const actual = {
      ...saved,
      revision: 'new',
      services: [{ ...service, serviceId: 'actual-id', publicKey: 'actual-public-key' }]
    }
    wait.resolve({ ok: true, data: actual })
    await operation
    expect(domain.catalog.value).toEqual(actual)
    expect(domain.serviceDraft.displayName).toBe('Next service')
    expect(domain.serviceDraft.httpsOrigin).toBe('')
    expect(addService).toHaveBeenCalledWith(
      expect.objectContaining({ ...service, revision: 'revision', version: 1 })
    )
  })

  it('removes a service and commits the returned catalog on a confirmed result', async () => {
    const withService: P2PCatalogView = {
      ...saved,
      services: [{ ...service, serviceId: 'actual-id', publicKey: 'actual-public-key' }]
    }
    const withoutService: P2PCatalogView = {
      ...saved,
      revision: 'after-remove',
      services: [],
      forgottenServiceIds: ['actual-id']
    }
    const removeService = vi.fn(async () => ({ ok: true as const, data: withoutService }))
    const { domain } = setup({ removeService })
    domain.catalog.value = withService
    await domain.removeService('actual-id')
    expect(removeService).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'actual-id', version: 1 })
    )
    expect(domain.catalog.value).toEqual(withoutService)
  })

  it('keeps the catalog unchanged on a typed refusal and surfaces the code', async () => {
    const withService: P2PCatalogView = {
      ...saved,
      services: [{ ...service, serviceId: 'actual-id', publicKey: 'actual-public-key' }]
    }
    const removeService = vi.fn(async () => ({
      ok: false as const,
      code: 'p2p.service_not_found' as const,
      message: 'p2p.service_not_found'
    }))
    const { domain } = setup({ removeService })
    domain.catalog.value = withService
    await domain.removeService('actual-id')
    expect(domain.catalog.value).toEqual(withService)
    expect(domain.operations['actual-id']).toMatchObject({
      phase: 'failed',
      error: 'p2p.service_not_found'
    })
  })

  it('treats a lost remove reply as unconfirmed and never retries it', async () => {
    const withService: P2PCatalogView = {
      ...saved,
      services: [{ ...service, serviceId: 'actual-id', publicKey: 'actual-public-key' }]
    }
    const removeService = vi.fn(async () => {
      throw new Error('reply lost')
    })
    const { domain } = setup({ removeService })
    domain.catalog.value = withService
    await domain.removeService('actual-id')
    expect(domain.operations['actual-id'].error).toBe('unconfirmed')
    expect(domain.catalog.value).toEqual(withService)
    expect(removeService).toHaveBeenCalledTimes(1)
  })
})
