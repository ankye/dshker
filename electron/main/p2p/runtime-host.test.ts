import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessLaunchView, LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerCatalog } from './catalog'
import type { PeerCatalogRecord } from './catalog-schema'
import type { PeerMainHandler } from './rpc'
import { PeerRuntimeHost, type PeerChannel } from './runtime-host'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const pairId = 'b'.repeat(12)
const attemptId = 'c'.repeat(12)
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
    catalogId: 'd'.repeat(12),
    services: [{ serviceId }],
    computers: [{ serviceId, pairId, pairState: 'active' }],
    forgottenServiceIds: []
  } as unknown as PeerCatalogRecord
  const inspect = vi
    .spyOn(catalog, 'inspect')
    .mockImplementation(async () => ({ revision: 'e'.repeat(64), record }))
  let handler: PeerMainHandler | undefined
  const observers = new Set<(error: PeerHelperError) => void>()
  const call = vi.fn(
    async (_method: string, _payload: unknown, _signal: AbortSignal): Promise<unknown> => ({})
  )
  // The channel is the running core's, shared with the catalog and the secret
  // store: this host attaches to it and detaches, and never closes it.
  const attach = vi.fn()
  const detach = vi.fn()
  const channel: PeerChannel = {
    call,
    serve: (value) => {
      attach()
      handler = value
      return () => {
        detach()
        if (handler === value) handler = undefined
      }
    },
    observe: (observer) => {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    }
  }
  const directories: string[] = []
  const catalogs: { serviceId: string; revision: string }[] = []
  const host = new PeerRuntimeHost({
    channel,
    catalog,
    onDirectoryChange: (changedServiceId) => directories.push(changedServiceId),
    onCatalogChange: (changedServiceId, revision) =>
      catalogs.push({ serviceId: changedServiceId, revision }),
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
    attach,
    detach,
    call,
    start,
    listeners,
    directories,
    catalogs,
    set: (value: LauncherHarnessLaunchView) => {
      launch = value
      for (const listener of listeners) listener(value)
    },
    emit: (value: unknown) => handler!('peer.state', { serviceId, state: value }, signal()),
    directoryChanged: (payload: unknown) => handler!('directory.changed', payload, signal()),
    catalogChanged: (payload: unknown) => handler!('catalog.changed', payload, signal()),
    connect: (payload: unknown = { serviceId, pairId }, requestSignal = signal()) =>
      handler!('runtime.connect', payload, requestSignal),
    unavailable: (error: PeerHelperError) => {
      for (const observer of [...observers]) observer(error)
    }
  }
}

describe('formal main P2P runtime ownership', () => {
  it('attaches to nothing and starts no DSH on construction or idle shutdown', async () => {
    const f = fixture()
    expect(f.host.snapshot()).toEqual({ error: '', peers: [] })
    await f.host.close()
    expect(f.attach).not.toHaveBeenCalled()
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
    expect(f.attach).not.toHaveBeenCalled()
  })

  it('uses exactly one channel and forwards only the actual authorized runtime binding', async () => {
    const f = fixture()
    const rpc = await f.host.start(signal())
    expect(await f.host.start(signal())).toBe(rpc)
    expect(f.attach).toHaveBeenCalledTimes(1)
    await f.emit(state('starting-runtime'))
    expect(await f.connect()).toEqual({ generation: 1, url })
    expect(f.start).not.toHaveBeenCalled()
    expect(JSON.stringify(f.host.snapshot())).not.toContain('token')
  })

  it('rejects unauthorized, malformed and forgotten callback requests before DSH access', async () => {
    const f = fixture()
    await f.host.start(signal())
    // A runtime request the core vouches for needs no stage this document was
    // told: the core owns one slot per direction now and asks only while an
    // answered attempt is at starting-runtime, so the pair's authorization is
    // the whole gate. The stage requirement made every answered attempt die as
    // p2p.runtime_request_unscoped.
    expect(await f.connect()).toEqual({ generation: 1, url })
    await expect(f.connect({ serviceId, pairId: 'f'.repeat(12) })).rejects.toMatchObject({
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
    expect(f.detach).toHaveBeenCalledTimes(1)
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

  it('contains invalidation failure, marks P2P failed and forbids implicit reattach', async () => {
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
    expect(f.attach).toHaveBeenCalledTimes(1)
    // The core is alive: the handler stays so it still receives the real reason
    // rather than a bare not-implemented.
    expect(f.detach).not.toHaveBeenCalled()
  })

  it('contains a channel failure without reattaching or retaining a ready projection', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('ready'))
    f.unavailable(new PeerHelperError('p2p.helper_unavailable'))
    expect(f.host.snapshot().peers[0].state).toMatchObject({
      stage: 'failed',
      error: 'p2p.helper_unavailable'
    })
    // A dead channel cannot deliver callbacks again, so the host releases its
    // handler and the state machine stays fenced.
    expect(f.detach).toHaveBeenCalled()
    await expect(f.host.start(signal())).rejects.toMatchObject({
      code: 'p2p.helper_unavailable'
    })
    expect(f.listeners.size).toBe(0)
    expect(f.attach).toHaveBeenCalledTimes(1)
    expect(f.start).not.toHaveBeenCalled()
  })

  it('fences late replays and terminal revival, and accepts a restarted peer', async () => {
    const f = fixture()
    await f.host.start(signal())
    await f.emit(state('ready'))
    // Same attempt regressing is a late frame from the attempt already recorded.
    await expect(f.emit(state('punching'))).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    // An attempt id this host has never seen is a peer that restarted and began
    // counting attempts again: its generation orders nothing across restarts,
    // and refusing it here is what made every connection after a peer restart
    // die as p2p.runtime_request_unscoped.
    await f.emit({ ...state('ready'), attemptId: 'f'.repeat(12) })
    expect(f.host.snapshot().peers[0].state.attemptId).toBe('f'.repeat(12))
    // A frame naming an attempt this host has already moved past is a replay.
    await expect(f.emit(state('ready'))).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    await f.emit({ ...state('disconnected'), attemptId: 'f'.repeat(12) })
    await expect(f.emit({ ...state('ready'), attemptId: 'f'.repeat(12) })).rejects.toMatchObject({
      code: 'p2p.stale_generation'
    })
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

  it('routes a well-formed directory change and refuses a malformed one', async () => {
    const f = fixture()
    await f.host.start(signal())
    expect(await f.directoryChanged({ serviceId, revision: 0 })).toEqual({})
    expect(f.directories).toEqual([serviceId])
    // The directory is the account's, not a pair's: a service with no active
    // computer still has a device list worth re-reading.
    f.record.computers.length = 0
    await f.directoryChanged({ serviceId, revision: 1 })
    expect(f.directories).toEqual([serviceId, serviceId])
    // A payload outside the core's vocabulary is refused rather than coerced:
    // an unknown id shape, a revision that could not have been counted, a
    // missing field or an extra one.
    for (const payload of [
      { serviceId: 'A'.repeat(12), revision: 1 },
      { serviceId: serviceId.slice(0, 11), revision: 1 },
      { serviceId, revision: -1 },
      { serviceId, revision: 1.5 },
      { serviceId },
      { serviceId, revision: 1, extra: true }
    ])
      await expect(f.directoryChanged(payload)).rejects.toThrow()
    expect(f.directories).toEqual([serviceId, serviceId])
  })

  it('routes a well-formed catalog change and refuses a malformed one', async () => {
    const f = fixture()
    await f.host.start(signal())
    const revision = 'a'.repeat(64)
    expect(await f.catalogChanged({ serviceId, revision })).toEqual({})
    expect(f.catalogs).toEqual([{ serviceId, revision }])
    // The catalog is the account's, not a pair's: a service with no computer left
    // still has a recorded set worth re-reading.
    f.record.computers.length = 0
    const second = 'b'.repeat(64)
    await f.catalogChanged({ serviceId, revision: second })
    expect(f.catalogs).toEqual([
      { serviceId, revision },
      { serviceId, revision: second }
    ])
    // A payload outside the core's vocabulary is refused rather than coerced: an
    // unknown id shape, a revision that is not the record's own hash, a missing
    // field or an extra one.
    for (const payload of [
      { serviceId: 'A'.repeat(12), revision },
      { serviceId: serviceId.slice(0, 11), revision },
      { serviceId, revision: second.toUpperCase() },
      { serviceId, revision: 'abc' },
      { serviceId, revision: 4 },
      { serviceId },
      { serviceId, revision, extra: true }
    ])
      await expect(f.catalogChanged(payload)).rejects.toThrow()
    expect(f.catalogs).toHaveLength(2)
  })
})
