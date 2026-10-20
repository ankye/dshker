import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerConnections } from './connections'

const serviceId = 'a'.repeat(12)
const pairId = '4'.repeat(12)
const otherPair = '5'.repeat(12)
const signal = () => AbortSignal.timeout(5000)
const url = 'http://127.0.0.1:51234/'

afterEach(() => vi.restoreAllMocks())

function state(generation: number, stage = 'punching', pair = pairId) {
  return {
    pairId: pair,
    attemptId: '7'.repeat(12),
    generation,
    stage,
    error: '',
    path: { localType: '', remoteType: '', protocol: '' },
    runtimeGeneration: 0
  }
}

function dispatchedGeneration(payload: unknown): number {
  return (payload as { data: { generation: number } }).data.generation
}

function fixture() {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  /** Answers one peer.connect with a reply naming the attempt that was sent. */
  const accept = (entry = url, stage = 'punching', pair = pairId) =>
    call.mockImplementationOnce((_method, payload) =>
      Promise.resolve({ state: state(dispatchedGeneration(payload), stage, pair), url: entry })
    )
  return { call, connections: new PeerConnections({ call }), accept }
}

describe('main-owned P2P connections', () => {
  it('keeps the local DSH entry URL out of the returned state', async () => {
    const f = fixture()
    f.accept()
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(JSON.stringify(accepted)).not.toContain('127.0.0.1')
    expect(JSON.stringify(accepted)).not.toContain(url)
    expect(f.call).toHaveBeenCalledWith(
      'peer.connect',
      expect.objectContaining({
        serviceId,
        data: expect.objectContaining({ requestWorkbench: true })
      }),
      expect.any(AbortSignal)
    )
  })

  it('never reports a dispatched attempt as ready', async () => {
    const f = fixture()
    f.accept()
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(accepted.stage).not.toBe('ready')
  })

  it('names attempts above anything an earlier process could have counted', async () => {
    const f = fixture()
    f.accept()
    const first = await f.connections.connect(serviceId, pairId, signal())
    // A counter starting at 1 names every attempt of a restarted process older
    // than the ones a previous process made, which a peer ordering attempts by
    // generation alone rejects as stale. The clock seed keeps a fresh attempt
    // the newest any peer has seen.
    expect(first.generation).toBeGreaterThan(1_000_000_000)
    f.accept()
    const second = await f.connections.connect(serviceId, pairId, signal())
    expect(second.generation).toBeGreaterThan(first.generation)
  })

  it('rejects a reply whose generation does not match the dispatched attempt', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(99), url })
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.stale_generation'
    })
  })

  it('rejects a reply naming a different pair', async () => {
    const f = fixture()
    f.accept(url, 'punching', otherPair)
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.identity_mismatch'
    })
  })

  // A reply without an address means the far computer has no workbench to offer,
  // which is a fact about that machine rather than a failure of the link.
  //
  // Rejecting it here discarded a connection that had already been negotiated,
  // so a peer whose DSH could not start — an unresolved pnpm, a dependency tree
  // the platform could not traverse — took the whole connection down with it,
  // along with everything else the link carries.
  it('accepts a connection reply that carries no workbench address', async () => {
    const f = fixture()
    f.accept('')
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(accepted.pairId).toBe(pairId)
  })

  it('refuses a reply whose entry point is not a string at all', async () => {
    const f = fixture()
    f.accept(1234 as unknown as string)
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.invalid_socket'
    })
  })

  it.each([{ state: state(99) }, { state: state(99), url, cached: true }])(
    'refuses a connect reply with missing or unexpected fields',
    async (reply) => {
      const f = fixture()
      f.call.mockResolvedValueOnce(reply)
      await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
        code: 'p2p.protocol_mismatch'
      })
    }
  )

  it('invalidates read ownership even when helper teardown fails', async () => {
    const f = fixture()
    const guard = f.connections.guardEntry(serviceId, pairId)
    f.call.mockRejectedValueOnce(new Error('teardown failed'))
    await expect(f.connections.disconnect(serviceId, pairId, signal())).rejects.toThrow()
    expect(guard).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
  })

  it('invalidates read ownership of one service without touching others', () => {
    const f = fixture()
    const otherService = 'b'.repeat(12)
    const first = f.connections.guardEntry(serviceId, pairId)
    const second = f.connections.guardEntry(otherService, pairId)
    f.connections.invalidate(serviceId)
    expect(first).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
    expect(second).not.toThrow()
  })

  it('refuses a concurrent operation on the same pair', async () => {
    const f = fixture()
    let release = (): void => {}
    f.call.mockImplementationOnce(
      (_method, payload) =>
        new Promise(
          (resolve) =>
            (release = () => resolve({ state: state(dispatchedGeneration(payload)), url }))
        )
    )
    const first = f.connections.connect(serviceId, pairId, signal())
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.connection_busy'
    })
    release()
    await first
  })

  it('invalidates every read once closed and refuses new guards', () => {
    const f = fixture()
    const guard = f.connections.guardEntry(serviceId, pairId)
    f.connections.close()
    expect(guard).toThrow(expect.objectContaining({ code: 'p2p.helper_closed' }))
    expect(() => f.connections.guardEntry(serviceId, pairId)).toThrow(
      expect.objectContaining({ code: 'p2p.helper_closed' })
    )
  })

  it('fences an entry lookup immediately when disconnect starts before a stage arrives', async () => {
    const f = fixture()
    const guard = f.connections.guardEntry(serviceId, pairId)
    let finish!: () => void
    f.call.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({}))))
    const pending = f.connections.disconnect(serviceId, pairId, signal())
    expect(guard).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
    expect(() => f.connections.guardEntry(serviceId, pairId)).toThrow(
      expect.objectContaining({ code: 'p2p.connection_busy' })
    )
    finish()
    await pending
    expect(guard).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
  })

  it('invalidates read ownership only for the named pair or service', () => {
    const f = fixture()
    const affected = f.connections.guardEntry(serviceId, pairId)
    const unaffected = f.connections.guardEntry(serviceId, otherPair)
    f.connections.invalidate(serviceId, pairId)
    expect(affected).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
    expect(unaffected).not.toThrow()
    f.connections.invalidate(serviceId)
    expect(unaffected).toThrow(expect.objectContaining({ code: 'p2p.stale_generation' }))
  })
})
