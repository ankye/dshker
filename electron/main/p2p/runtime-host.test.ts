import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessLaunchView, LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerCatalog } from './catalog'
import type { PeerCatalogRecord } from './catalog-schema'
import type { PeerMainHandler } from './rpc'
import { PeerRuntimeHost } from './runtime-host'
import { PeerSupervisor, type PeerSupervisorOptions } from './supervisor'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(64)
const pairId = 'b'.repeat(32)
const attemptId = 'c'.repeat(32)
const url = 'http://127.0.0.1:31234/?token=unit-test-only'
const signal = () => new AbortController().signal
const hosts: PeerRuntimeHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
  vi.restoreAllMocks()
})

function state(stage = 'punching') {
  return {
    pairId,
    attemptId,
    generation: 1,
    stage,
    error: '',
    runtimeGeneration: stage === 'ready' ? 1 : 0,
    path:
      stage === 'punching'
        ? { localType: '', remoteType: '', protocol: '' }
        : { localType: 'host', remoteType: 'srflx', protocol: 'udp' }
  }
}

function fixture() {
  let launch: LauncherHarnessLaunchView = { kind: 'running', url }
  const listeners = new Set<(state: LauncherHarnessLaunchView) => void>()
  const start = vi.fn(async () => ({ launch }) as LauncherHarnessState)
  const catalog = new PeerCatalog(async () => {
    throw new Error('test must supply catalog readback')
  })
  // Catalog cryptography/persistence has its own real-file suite. This fixture
  // isolates ownership and callback admission, not those already-tested layers.
  const record = {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: 'd'.repeat(32),
    services: [{ serviceId }],
    computers: [{ serviceId, pairId, pairState: 'active' }],
    forgottenServiceIds: []
  } as unknown as PeerCatalogRecord
  const inspect = vi
    .spyOn(catalog, 'inspect')
    .mockImplementation(async () => ({ revision: 'e'.repeat(64), record }))
  let handler: PeerMainHandler
  let unavailable: PeerSupervisorOptions['onUnavailable']
  const call = vi.fn(
    async (_method: string, _payload: unknown, _signal: AbortSignal): Promise<unknown> => ({})
  )
  const close = vi.fn(async () => undefined)
  const spawn = vi.spyOn(PeerSupervisor, 'start').mockImplementation(async (options) => {
    handler = options.handler
    unavailable = options.onUnavailable
    return { rpc: { call }, close } as unknown as PeerSupervisor
  })
  const host = new PeerRuntimeHost({
    resourcesRoot: '/test-owned-resources',
    catalog,
    runtime: {
      getRuntimeState: () => launch,
      onRuntimeState: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      start
    }
  })
  hosts.push(host)
  return {
    host,
    record,
    inspect,
    spawn,
    call,
    close,
    start,
    listeners,
    set: (value: LauncherHarnessLaunchView) => {
      launch = value
      for (const listener of listeners) listener(value)
    },
    emit: (value: unknown) => handler('peer.state', { serviceId, state: value }, signal()),
    connect: (payload: unknown = { serviceId, pairId }, requestSignal = signal()) =>
      handler('runtime.connect', payload, requestSignal),
    unavailable: (error: PeerHelperError) => unavailable(error)
  }
}

describe('formal main P2P runtime ownership', () => {
  it('does not start a helper or DSH on construction or idle shutdown', async () => {
    const f = fixture()
    expect(f.host.snapshot()).toEqual({ error: '', peers: [] })
    await f.host.close()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  })

  it('requires explicit enable and admits a pre-cancelled request without side effects', async () => {
    const f = fixture()
    f.inspect.mockResolvedValueOnce(undefined)
    await expect(f.host.start(signal())).rejects.toMatchObject({ code: 'p2p.not_enabled' })
    await expect(f.host.start(AbortSignal.abort())).rejects.toMatchObject({
      code: 'p2p.request_cancelled'
    })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('uses exactly one helper and forwards only the actual authorized runtime binding', async () => {
    const f = fixture()
    const rpc = await f.host.start(signal())
    expect(await f.host.start(signal())).toBe(rpc)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    await f.emit(state('starting-runtime'))
    expect(await f.connect()).toEqual({ generation: 1, url })
    expect(f.start).not.toHaveBeenCalled()
    expect(JSON.stringify(f.host.snapshot())).not.toContain('token')
  })

  it('rejects unauthorized, forgotten, revoked and unscoped callback requests before DSH access', async () => {
    const f = fixture()
    await f.host.start(signal())
    await expect(f.connect()).rejects.toMatchObject({ code: 'p2p.runtime_request_unscoped' })
    await expect(f.connect({ serviceId, pairId: 'f'.repeat(32) })).rejects.toMatchObject({
      code: 'p2p.pair_unauthorized'
    })
    await expect(f.connect({ serviceId, pairId, url })).rejects.toThrow()
    f.record.computers[0].pairState = 'revoked'
    await expect(f.emit(state())).rejects.toMatchObject({ code: 'p2p.pair_unauthorized' })
    f.record.forgottenServiceIds.push(serviceId)
    await expect(f.connect()).rejects.toMatchObject({ code: 'p2p.trust_restore_rejected' })
    expect(f.start).not.toHaveBeenCalled()
  })

  it('invalidates the real service manager on stop and never kills the DSH process on close', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('starting-runtime'))
    await f.connect()
    f.set({ kind: 'stopped' })
    await vi.waitFor(() =>
      expect(f.call).toHaveBeenCalledWith(
        'runtime.invalidate',
        {
          serviceId,
          data: { generation: 1 }
        },
        expect.any(AbortSignal)
      )
    )
    f.set({ kind: 'running', url: url.replace('31234', '31235') })
    expect(await f.connect()).toEqual({ generation: 2, url: url.replace('31234', '31235') })
    await f.host.close()
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('does not invalidate a service that never requested the local runtime', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('ready'))
    f.set({ kind: 'stopped' })
    expect(f.call).not.toHaveBeenCalled()
  })

  it('rejects a binding retired during the final catalog readback', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('starting-runtime'))
    const saved = await f.inspect()
    f.inspect.mockResolvedValueOnce(saved).mockImplementationOnce(async () => {
      f.set({ kind: 'stopped' })
      return saved
    })
    await expect(f.connect()).rejects.toMatchObject({ code: 'p2p.runtime_invalidated' })
  })

  it('rechecks pair revocation after waiting for the actual DSH announcement', async () => {
    const f = fixture()
    await f.host.start(signal())
    f.set({ kind: 'starting' })
    await f.emit(state('starting-runtime'))
    const connecting = f.connect()
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'p2p.pair_unauthorized' })
    // Allow the first catalog admission to finish before retiring authorization.
    await Promise.resolve()
    await Promise.resolve()
    f.record.computers[0].pairState = 'revoked'
    f.set({ kind: 'running', url })
    await rejected
    expect(f.start).not.toHaveBeenCalled()
  })

  it('contains invalidation failure, marks P2P failed and forbids implicit helper restart', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('starting-runtime'))
    await f.connect()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.request_timeout'))
    f.set({ kind: 'stopped' })
    await vi.waitFor(() => expect(f.host.snapshot().error).toBe('p2p.runtime_invalidation_failed'))
    expect(f.host.snapshot().peers[0].state.stage).toBe('failed')
    await expect(f.host.start(signal())).rejects.toMatchObject({
      code: 'p2p.runtime_invalidation_failed'
    })
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalled()
  })

  it('contains a helper crash without restarting or retaining a ready projection', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('ready'))
    f.unavailable(new PeerHelperError('p2p.helper_unavailable'))
    expect(f.host.snapshot().peers[0].state).toMatchObject({
      stage: 'failed',
      error: 'p2p.helper_unavailable'
    })
    await expect(f.connect()).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    expect(f.listeners.size).toBe(0)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('fences late state, conflicting attempts and terminal-to-ready revival', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('ready'))
    await expect(f.emit(state('punching'))).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    await expect(f.emit({ ...state('ready'), attemptId: 'f'.repeat(32) })).rejects.toMatchObject({
      code: 'p2p.attempt_mismatch'
    })
    await f.emit(state('disconnected'))
    await expect(f.emit(state('ready'))).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    expect(f.host.snapshot().peers[0].state.stage).toBe('disconnected')
    const copied = f.host.snapshot()
    copied.peers[0].state.path.protocol = 'modified'
    expect(f.host.snapshot().peers[0].state.path.protocol).toBe('udp')
  })

  it.each([
    { ...state('ready'), url },
    { ...state('ready'), runtimeGeneration: 0 },
    { ...state('ready'), path: { localType: 'relay', remoteType: 'host', protocol: 'udp' } },
    { ...state('ready'), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...state('failed'), error: '' }
  ])('rejects malformed or non-direct state without projection changes', async (value) => {
    const f = fixture()
    await f.host.start(signal())
    await expect(f.emit(value)).rejects.toThrow()
    expect(f.host.snapshot().peers).toEqual([])
  })
})
