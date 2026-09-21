import { describe, expect, it, vi } from 'vitest'
import {
  P2P_BUILTIN_SERVICE,
  type P2PManagementApi,
  type P2PCatalogView
} from '@/shared/p2p-management'
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
  /**
   * A whole-machine read that carries no service must not land in the catalog's
   * operation slot. The status line and the connections panel mount beside the
   * catalog card, and a successful serviceSessions call used to overwrite the
   * catalog's failure: the card then showed "nothing read yet" with no code, so a
   * stored configuration this build cannot read looked like an empty one and the
   * offered retry could never succeed.
   */
  it('keeps a machine-wide read out of the catalog operation slot', async () => {
    const { domain } = setup({
      catalog: vi.fn(async () => ({
        ok: false as const,
        code: 'p2p.catalog_invalid' as const,
        message: 'p2p.catalog_invalid'
      })),
      serviceSessions: vi.fn(async () => ({ ok: true as const, data: [] }))
    })
    await domain.readCatalog()
    expect(domain.operations.catalog).toMatchObject({
      method: 'catalog',
      phase: 'failed',
      error: 'p2p.catalog_invalid'
    })
    await domain.run('serviceSessions', {})
    expect(domain.operations.catalog).toMatchObject({
      method: 'catalog',
      phase: 'failed',
      error: 'p2p.catalog_invalid'
    })
    expect(domain.operations.serviceSessions).toMatchObject({ method: 'serviceSessions' })
  })

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

  /**
   * The private channel admits sixteen concurrent calls and refuses the rest with
   * p2p.helper_busy, so a burst has to be queued here. It used to be refused, and
   * the refusal landed on whichever read lost the race — which is how a device list
   * that had already been fetched came to be reported as unreadable.
   */
  it('queues a burst instead of letting the channel refuse part of it', async () => {
    let active = 0
    let peak = 0
    const pending: (() => void)[] = []
    const currentUser = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => pending.push(resolve))
      active -= 1
      return { ok: true as const, data: { userId: 'user', username: 'alice' } }
    })
    const { domain } = setup({ currentUser })
    // One scope per call: the point of this test is the channel, not the lock.
    const calls = Array.from({ length: 20 }, (_, index) =>
      domain.run('currentUser', { serviceId: `service-${index}` })
    )
    await Promise.resolve()
    expect(peak).toBeLessThanOrEqual(6)
    // Let one call finish at a time: each freed slot admits the next waiting call,
    // so the peak stays bounded while all twenty eventually run.
    for (let released = 0; released < 20; released += 1) {
      for (let spin = 0; spin < 50 && pending.length === 0; spin += 1) await Promise.resolve()
      pending.shift()?.()
      await Promise.resolve()
    }
    const results = await Promise.all(calls)
    expect(peak).toBeLessThanOrEqual(6)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(currentUser).toHaveBeenCalledTimes(20)
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

describe('built-in official server provisioning', () => {
  const builtin = {
    serviceId: 'b'.repeat(12),
    publicKey: 'pinned-key',
    displayName: P2P_BUILTIN_SERVICE.displayName,
    httpsOrigin: P2P_BUILTIN_SERVICE.httpsOrigin,
    wssUrl: P2P_BUILTIN_SERVICE.wssUrl,
    stunAddress: P2P_BUILTIN_SERVICE.stunAddress
  }

  it('enables, adds and selects the built-in service exactly once', async () => {
    const enable = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'enabled' }
    }))
    const addService = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'added', services: [builtin] }
    }))
    const { domain } = setup({ enable, addService })
    domain.catalog.value = null
    await domain.ensureBuiltinService()
    expect(enable).toHaveBeenCalledTimes(1)
    expect(addService).toHaveBeenCalledTimes(1)
    expect(addService).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 'enabled',
        displayName: P2P_BUILTIN_SERVICE.displayName,
        httpsOrigin: P2P_BUILTIN_SERVICE.httpsOrigin,
        wssUrl: P2P_BUILTIN_SERVICE.wssUrl,
        stunAddress: P2P_BUILTIN_SERVICE.stunAddress
      })
    )
    expect(domain.selectedServiceId.value).toBe(builtin.serviceId)
    expect(domain.builtinProvisioned.value).toBe(true)
    expect(domain.builtinRemoved.value).toBe(false)
    // Idempotent: a repeated call never adds or selects again.
    domain.selectedServiceId.value = undefined
    await domain.ensureBuiltinService()
    expect(addService).toHaveBeenCalledTimes(1)
    expect(domain.selectedServiceId.value).toBeUndefined()
  })

  it('selects an already-present built-in service without adding anything', async () => {
    const addService = vi.fn()
    const { domain } = setup({ addService })
    domain.catalog.value = { ...saved, services: [builtin] }
    await domain.ensureBuiltinService()
    expect(addService).not.toHaveBeenCalled()
    expect(domain.selectedServiceId.value).toBe(builtin.serviceId)
    expect(domain.builtinProvisioned.value).toBe(true)
  })

  it('shares the in-flight built-in provisioning between shell startup readers', async () => {
    const enable = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'enabled' }
    }))
    const addService = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'added', services: [builtin] }
    }))
    const { domain } = setup({ enable, addService })
    domain.catalog.value = null
    await Promise.all([domain.ensureBuiltinService(), domain.ensureBuiltinService()])
    expect(enable).toHaveBeenCalledTimes(1)
    expect(addService).toHaveBeenCalledTimes(1)
    expect(domain.selectedServiceId.value).toBe(builtin.serviceId)
  })

  /**
   * A record this build cannot read leaves the page with no catalog at all, and
   * discarding it is the only way forward — so the reset must hand the user a
   * working page, not a fresh "nothing read yet" that asks for the same act again.
   */
  it('discards an unreadable catalog and provisions the built-in service again', async () => {
    const resetCatalog = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'reset' }
    }))
    const addService = vi.fn(async () => ({
      ok: true as const,
      data: { ...saved, revision: 'added', services: [builtin] }
    }))
    const { domain } = setup({ resetCatalog, addService })
    domain.catalog.value = undefined
    domain.builtinProvisioned.value = false
    await domain.resetCatalog()
    expect(resetCatalog).toHaveBeenCalledTimes(1)
    expect(addService).toHaveBeenCalledWith(expect.objectContaining({ revision: 'reset' }))
    expect(domain.selectedServiceId.value).toBe(builtin.serviceId)
    expect(domain.builtinProvisioned.value).toBe(true)
  })

  it('keeps the catalogue untouched when the discard itself is refused', async () => {
    const resetCatalog = vi.fn(async () => ({
      ok: false as const,
      code: 'p2p.catalog_intact' as const,
      message: 'p2p.catalog_intact'
    }))
    const addService = vi.fn()
    const { domain } = setup({ resetCatalog, addService })
    domain.catalog.value = saved
    await domain.resetCatalog()
    expect(addService).not.toHaveBeenCalled()
    expect(domain.catalog.value).toEqual(saved)
    expect(domain.operations.catalog).toMatchObject({
      phase: 'failed',
      error: 'p2p.catalog_intact'
    })
  })

  it('records the terminal removed state when re-adding the built-in is refused', async () => {
    const addService = vi.fn(async () => ({
      ok: false as const,
      code: 'p2p.trust_restore_rejected' as const,
      message: 'p2p.trust_restore_rejected'
    }))
    const { domain } = setup({ addService })
    domain.catalog.value = saved
    await domain.ensureBuiltinService()
    expect(addService).toHaveBeenCalledTimes(1)
    expect(domain.builtinRemoved.value).toBe(true)
    expect(domain.builtinProvisioned.value).toBe(false)
    expect(domain.selectedServiceId.value).toBeUndefined()
    // No loop: further calls are no-ops.
    await domain.ensureBuiltinService()
    expect(addService).toHaveBeenCalledTimes(1)
  })

  it('stays retryable when provisioning cannot confirm anything', async () => {
    const addService = vi.fn()
    const { domain } = setup({ addService })
    domain.catalog.value = saved
    await domain.ensureBuiltinService()
    expect(domain.builtinProvisioned.value).toBe(false)
    expect(domain.builtinRemoved.value).toBe(false)
    // A later mount may retry without a terminal state being recorded.
    await domain.ensureBuiltinService()
    expect(addService).toHaveBeenCalledTimes(2)
  })
})
