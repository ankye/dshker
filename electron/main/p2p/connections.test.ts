import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerConnections } from './connections'

const serviceId = 'a'.repeat(64)
const pairId = '4'.repeat(32)
const otherPair = '5'.repeat(32)
const signal = () => AbortSignal.timeout(5000)
const url = 'http://127.0.0.1:51234/'

afterEach(() => vi.restoreAllMocks())

function state(generation: number, stage = 'punching', pair = pairId) {
  return {
    pairId: pair,
    attemptId: '7'.repeat(32),
    generation,
    stage,
    error: '',
    path: { localType: '', remoteType: '', protocol: '' },
    runtimeGeneration: 0
  }
}

function fixture() {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  return { call, connections: new PeerConnections({ call }) }
}

describe('main-owned P2P connections', () => {
  it('keeps the local DSH entry URL out of the returned state', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(JSON.stringify(accepted)).not.toContain('127.0.0.1')
    expect(JSON.stringify(accepted)).not.toContain(url)
  })

  it('never reports a dispatched attempt as ready', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(accepted.stage).not.toBe('ready')
  })

  it('assigns an increasing generation per attempt so late callbacks are detectable', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    await f.connections.connect(serviceId, pairId, signal())
    f.call.mockResolvedValueOnce({ state: state(2), url })
    const second = await f.connections.connect(serviceId, pairId, signal())
    expect(second.generation).toBe(2)
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
    f.call.mockResolvedValueOnce({ state: state(1, 'punching', otherPair), url })
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.identity_mismatch'
    })
  })

  it('refuses a connection reply that carries no usable entry point', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url: '' })
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.invalid_socket'
    })
  })

  it('hands the entry point only for the matching generation', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    expect(f.connections.entry(serviceId, pairId, accepted.generation)).toBe(url)
    // A superseded attempt must not resurrect an old entry point.
    expect(() => f.connections.entry(serviceId, pairId, accepted.generation + 1)).toThrow(
      expect.objectContaining({ code: 'p2p.stale_generation' })
    )
  })

  it('drops the entry point on disconnect so the old URL cannot be reused', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    f.call.mockResolvedValueOnce({})
    await f.connections.disconnect(serviceId, pairId, signal())
    expect(() => f.connections.entry(serviceId, pairId, accepted.generation)).toThrow(
      expect.objectContaining({ code: 'p2p.connection_not_found' })
    )
  })

  it('drops the entry point even when helper teardown fails', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    f.call.mockRejectedValueOnce(new Error('teardown failed'))
    await expect(f.connections.disconnect(serviceId, pairId, signal())).rejects.toThrow()
    // A failed teardown must not leave a usable local entry point behind.
    expect(() => f.connections.entry(serviceId, pairId, accepted.generation)).toThrow(
      expect.objectContaining({ code: 'p2p.connection_not_found' })
    )
  })

  it('invalidates every entry point of one service without touching others', async () => {
    const f = fixture()
    const otherService = 'b'.repeat(64)
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const first = await f.connections.connect(serviceId, pairId, signal())
    f.call.mockResolvedValueOnce({ state: state(2), url: `${url}other` })
    const second = await f.connections.connect(otherService, pairId, signal())
    f.connections.invalidate(serviceId)
    expect(() => f.connections.entry(serviceId, pairId, first.generation)).toThrow()
    expect(f.connections.entry(otherService, pairId, second.generation)).toBe(`${url}other`)
  })

  it('refuses a concurrent operation on the same pair', async () => {
    const f = fixture()
    let release = (): void => {}
    f.call.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ state: state(1), url })))
    )
    const first = f.connections.connect(serviceId, pairId, signal())
    await expect(f.connections.connect(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.connection_busy'
    })
    release()
    await first
  })

  it('clears every entry point once closed', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ state: state(1), url })
    const accepted = await f.connections.connect(serviceId, pairId, signal())
    f.connections.close()
    expect(() => f.connections.entry(serviceId, pairId, accepted.generation)).toThrow(
      expect.objectContaining({ code: 'p2p.connection_not_found' })
    )
  })
})
