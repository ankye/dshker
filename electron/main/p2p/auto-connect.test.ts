import { describe, expect, it, vi } from 'vitest'
import { PeerAutoConnect } from './auto-connect'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(64)
const pairId = '1'.repeat(32)
const other = '2'.repeat(32)

/** A controllable clock so backoff is asserted without waiting. */
function clock() {
  const pending: { callback: () => void; delay: number }[] = []
  return {
    delays: () => pending.map((entry) => entry.delay),
    async fire() {
      const entry = pending.shift()
      if (!entry) throw new Error('no timer scheduled')
      entry.callback()
      await Promise.resolve()
      await Promise.resolve()
    },
    setTimer(callback: () => void, delay: number) {
      const entry = { callback, delay }
      pending.push(entry)
      return {
        cancel() {
          const index = pending.indexOf(entry)
          if (index >= 0) pending.splice(index, 1)
        }
      }
    }
  }
}

describe('PeerAutoConnect', () => {
  it('stops retrying a pair whose authorization the core refused', async () => {
    // These are the codes the core really answers with when this device holds no
    // pin for a pair, or when a network's authorization was withdrawn. Without
    // them the pair stayed listed as active and was re-attempted forever while
    // the refusal never reached a surface.
    for (const code of ['p2p.pair_unauthorized', 'p2p.network_revoked']) {
      const connect = vi.fn().mockRejectedValue(new PeerHelperError(code))
      const auto = new PeerAutoConnect({
        intents: () => Promise.resolve([{ serviceId, pairId }]),
        stage: () => undefined,
        connect
      })
      await auto.reconcile()
      await Promise.resolve()
      expect(auto.refusal(serviceId, pairId)).toBe(code)
      await auto.reconcile()
      expect(connect).toHaveBeenCalledTimes(1)
      auto.close()
    }
  })

  it('connects every authorized pair without a user action', async () => {
    const connect = vi.fn().mockResolvedValue({})
    const auto = new PeerAutoConnect({
      intents: () =>
        Promise.resolve([
          { serviceId, pairId },
          { serviceId, pairId: other }
        ]),
      stage: () => undefined,
      connect
    })
    await auto.reconcile()
    await Promise.resolve()
    expect(connect.mock.calls.map((call) => call[1])).toEqual([pairId, other])
    auto.close()
  })

  it('leaves a live connection alone, so returning to a tab never re-punches', async () => {
    const connect = vi.fn().mockResolvedValue({})
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'ready',
      connect
    })
    await auto.reconcile()
    await auto.reconcile()
    await auto.reconcile()
    expect(connect).not.toHaveBeenCalled()
    auto.close()
  })

  it('does not start a second attempt while one is connecting', async () => {
    const connect = vi.fn().mockResolvedValue({})
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'punching',
      connect
    })
    await auto.reconcile()
    expect(connect).not.toHaveBeenCalled()
    auto.close()
  })

  it('retries a dropped connection with a widening delay, capped and forever', async () => {
    const timer = clock()
    const connect = vi.fn().mockRejectedValue(new PeerHelperError('p2p.helper_busy'))
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'disconnected',
      connect,
      setTimer: timer.setTimer
    })
    await auto.reconcile()
    await Promise.resolve()
    expect(timer.delays()).toEqual([1_000])
    for (const expected of [2_000, 5_000, 15_000, 60_000, 60_000]) {
      await timer.fire()
      expect(timer.delays()).toEqual([expected])
    }
    expect(connect.mock.calls.length).toBeGreaterThan(5)
    auto.close()
  })

  it('stops retrying only when authorization is gone, and says why', async () => {
    const timer = clock()
    const connect = vi.fn().mockRejectedValue(new PeerHelperError('p2p.pair_revoked'))
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'disconnected',
      connect,
      setTimer: timer.setTimer
    })
    await auto.reconcile()
    await Promise.resolve()
    expect(timer.delays()).toEqual([])
    expect(auto.refusal(serviceId, pairId)).toBe('p2p.pair_revoked')
    await auto.reconcile()
    expect(connect).toHaveBeenCalledTimes(1)
    auto.close()
  })

  it('retries immediately when the machine changes state', async () => {
    const timer = clock()
    const connect = vi.fn().mockRejectedValue(new PeerHelperError('p2p.no_direct_path'))
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'disconnected',
      connect,
      setTimer: timer.setTimer
    })
    await auto.reconcile()
    await Promise.resolve()
    await timer.fire()
    await timer.fire()
    expect(timer.delays()).toEqual([5_000])
    auto.retryNow()
    await Promise.resolve()
    await Promise.resolve()
    // The waiting delay is dropped and the attempt restarts from the first step.
    expect(timer.delays()).toEqual([1_000])
    auto.close()
  })

  it('drops a pair that is no longer authorized', async () => {
    const timer = clock()
    const connect = vi.fn().mockRejectedValue(new PeerHelperError('p2p.helper_busy'))
    let intents = [{ serviceId, pairId }]
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve(intents),
      stage: () => 'disconnected',
      connect,
      setTimer: timer.setTimer
    })
    await auto.reconcile()
    await Promise.resolve()
    expect(timer.delays()).toEqual([1_000])
    intents = []
    await auto.reconcile()
    expect(timer.delays()).toEqual([])
    auto.close()
  })

  it('stops all work once closed', async () => {
    const timer = clock()
    const connect = vi.fn().mockRejectedValue(new PeerHelperError('p2p.helper_busy'))
    const auto = new PeerAutoConnect({
      intents: () => Promise.resolve([{ serviceId, pairId }]),
      stage: () => 'disconnected',
      connect,
      setTimer: timer.setTimer
    })
    await auto.reconcile()
    await Promise.resolve()
    auto.close()
    expect(timer.delays()).toEqual([])
    await auto.reconcile()
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
