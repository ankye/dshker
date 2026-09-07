import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerManagementRequests } from './management-requests'

function page() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'dsh-app://launcher/' } })
  return {
    sender,
    event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  }
}
function held() {
  let finish!: (value: string) => void
  let signal!: AbortSignal
  const promise = new Promise<string>((resolve) => {
    finish = resolve
  })
  return {
    operation: (active: AbortSignal) => {
      signal = active
      return promise
    },
    finish,
    signal: () => signal
  }
}
afterEach(() => vi.useRealTimers())

describe('management request document ownership', () => {
  it('rejects replay across operations but preserves independent windows', async () => {
    const requests = new PeerManagementRequests()
    const a = page(),
      b = page()
    const operation = vi.fn(async () => 'readback')
    expect(await requests.run(a.event, 3, false, operation)).toBe('readback')
    await expect(requests.run(a.event, 3, false, operation)).rejects.toMatchObject({
      code: 'p2p.request_replayed'
    })
    await expect(requests.run(a.event, 2, true, operation)).rejects.toMatchObject({
      code: 'p2p.request_replayed'
    })
    expect(await requests.run(b.event, 1, false, operation)).toBe('readback')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('caps pending requests without losing the owned cancellation path', async () => {
    const requests = new PeerManagementRequests(),
      a = page()
    const waits = Array.from({ length: 16 }, held)
    const results = waits.map((wait, index) =>
      requests.run(a.event, index + 1, false, wait.operation).catch((error) => error.code)
    )
    const rejected = vi.fn(async () => 'not admitted')
    await expect(requests.run(a.event, 17, false, rejected)).rejects.toMatchObject({
      code: 'p2p.request_limit'
    })
    expect(rejected).not.toHaveBeenCalled()
    expect(requests.cancel(a.event, 18, 1)).toEqual({ accepted: true })
    expect(waits[0].signal().aborted).toBe(true)
    expect(waits[1].signal().aborted).toBe(false)
    waits.forEach((wait, index) => wait.finish(String(index)))
    expect(await Promise.all(results)).toEqual([
      'p2p.request_cancelled',
      ...Array.from({ length: 15 }, (_, index) => String(index + 1))
    ])
    expect(await requests.run(a.event, 19, false, async () => 'capacity recovered')).toBe(
      'capacity recovered'
    )
  })

  it('cannot cancel another document and reports accepted writes as unconfirmed, not rolled back', async () => {
    const requests = new PeerManagementRequests(),
      a = page(),
      b = page(),
      wait = held()
    const result = requests.run(a.event, 1, true, wait.operation).catch((error) => error.code)
    expect(() => requests.cancel(b.event, 1, 1)).toThrow('p2p.request_unavailable')
    expect(wait.signal().aborted).toBe(false)
    expect(requests.cancel(a.event, 2, 1)).toEqual({ accepted: true })
    wait.finish('server committed')
    expect(await result).toBe('p2p.management_result_unconfirmed')
    expect(() => requests.cancel(a.event, 3, 1)).toThrow('p2p.request_unavailable')
  })

  it.each([false, true])('enforces the 120 second deadline; writes=%s', async (writes) => {
    vi.useFakeTimers()
    const requests = new PeerManagementRequests(),
      a = page(),
      wait = held()
    const result = requests.run(a.event, 1, writes, wait.operation).catch((error) => error.code)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(wait.signal().aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wait.signal().aborted).toBe(true)
    wait.finish('late reply')
    expect(await result).toBe(writes ? 'p2p.management_result_unconfirmed' : 'p2p.request_timeout')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires navigation work and rejects old document calls before the next DOM is ready', async () => {
    const requests = new PeerManagementRequests(),
      a = page(),
      old = held(),
      current = held()
    const oldResult = requests.run(a.event, 1, false, old.operation).catch((error) => error.code)
    a.sender.emit('did-start-navigation', {}, 'dsh-app://launcher/new', false, false)
    expect(old.signal().aborted).toBe(false)
    a.sender.emit('did-start-navigation', {}, 'dsh-app://launcher/#section', true, true)
    expect(old.signal().aborted).toBe(false)
    a.sender.emit('did-start-navigation', {}, 'dsh-app://launcher/new', false, true)
    expect(old.signal().aborted).toBe(true)
    await expect(requests.run(a.event, 2, false, async () => 'old page')).rejects.toMatchObject({
      code: 'p2p.ipc_invalid_sender'
    })
    a.sender.emit('dom-ready')
    const currentResult = requests
      .run(a.event, 1, false, current.operation)
      .catch((error) => error.code)
    old.finish('stale result')
    expect(await oldResult).toBe('p2p.request_cancelled')
    expect(current.signal().aborted).toBe(false)
    expect(requests.cancel(a.event, 2, 1)).toEqual({ accepted: true })
    current.finish('current result')
    expect(await currentResult).toBe('p2p.request_cancelled')
    expect(a.sender.listenerCount('did-start-navigation')).toBe(1)
  })

  it.each(['destroyed', 'render-process-gone'])(
    '%s aborts owned work without stopping other windows',
    async (eventName) => {
      const requests = new PeerManagementRequests(),
        a = page(),
        b = page(),
        first = held(),
        second = held()
      const aResult = requests.run(a.event, 1, false, first.operation).catch((error) => error.code)
      const bResult = requests.run(b.event, 1, false, second.operation)
      a.sender.emit(eventName)
      expect(first.signal().aborted).toBe(true)
      expect(second.signal().aborted).toBe(false)
      first.finish('old')
      second.finish('other window')
      expect(await aResult).toBe('p2p.request_cancelled')
      expect(await bResult).toBe('other window')
      expect(a.sender.listenerCount('did-start-navigation')).toBe(0)
      expect(a.sender.listenerCount('render-process-gone')).toBe(0)
    }
  )
})
