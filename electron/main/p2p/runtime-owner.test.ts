import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessLaunchView, LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerRuntimeOwner } from './runtime-owner'

const url = 'http://127.0.0.1:31991/?token=test-only-first'
const owners: PeerRuntimeOwner[] = []
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close()
  vi.useRealTimers()
})

function fixture(initial: LauncherHarnessLaunchView = { kind: 'stopped' }) {
  let state = initial
  const listeners = new Set<(value: LauncherHarnessLaunchView) => void>()
  const set = (value: LauncherHarnessLaunchView) => {
    state = value
    for (const listener of listeners) listener(value)
  }
  const start = vi.fn(async () => {
    set({ kind: 'starting' })
    return { launch: state } as LauncherHarnessState
  })
  const invalidate = vi.fn()
  const owner = new PeerRuntimeOwner(
    {
      getRuntimeState: () => state,
      onRuntimeState: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      start
    },
    invalidate
  )
  owners.push(owner)
  return { owner, set, start, invalidate }
}

describe('P2P owned DSH lifecycle', () => {
  it('rejects a retired binding after an asynchronous admission read', async () => {
    const { owner, set } = fixture({ kind: 'running', url })
    const binding = await owner.connect(new AbortController().signal)
    expect(() => owner.assertCurrent(binding)).not.toThrow()
    set({ kind: 'stopped' })
    expect(() => owner.assertCurrent(binding)).toThrowError('p2p.runtime_invalidated')
    set({ kind: 'running', url })
    expect(() => owner.assertCurrent(binding)).toThrowError('p2p.runtime_invalidated')
  })
  it('uses an already-running exact dynamic URL without starting or consulting port settings', async () => {
    const { owner, start } = fixture({ kind: 'running', url })
    const first = await owner.connect(new AbortController().signal)
    expect(first).toEqual({ generation: 1, url })
    first.url = 'changed by caller'
    expect(await owner.connect(new AbortController().signal)).toEqual({ generation: 1, url })
    expect(start).not.toHaveBeenCalled()
  })

  it('coalesces cold-start callers and cancels only the caller, retaining DSH', async () => {
    const { owner, start, set, invalidate } = fixture()
    const controller = new AbortController()
    const first = owner.connect(controller.signal)
    const cancelled = expect(first).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    const second = owner.connect(new AbortController().signal)
    controller.abort()
    await cancelled
    set({ kind: 'running', url })
    expect(await second).toEqual({ generation: 1, url })
    expect(start).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(await owner.connect(new AbortController().signal)).toEqual({ generation: 1, url })
  })

  it('does not start on pre-admission cancellation', async () => {
    const { owner, start } = fixture()
    await expect(owner.connect(AbortSignal.abort())).rejects.toMatchObject({
      code: 'p2p.request_cancelled'
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('waits for a start owned elsewhere instead of creating another child', async () => {
    const { owner, start, set } = fixture({ kind: 'starting' })
    const pending = owner.connect(new AbortController().signal)
    set({ kind: 'running', url })
    expect(await pending).toEqual({ generation: 1, url })
    expect(start).not.toHaveBeenCalled()
  })

  it('retires the exact generation on stop and uses the new announcement after restart', async () => {
    const { owner, set, invalidate } = fixture({ kind: 'running', url })
    set({ kind: 'stopped' })
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(1)
    const pending = owner.connect(new AbortController().signal)
    const next = 'http://127.0.0.1:32002/?token=test-only-second'
    set({ kind: 'running', url: next })
    expect(await pending).toEqual({ generation: 2, url: next })
    set({ kind: 'running', url: next })
    expect(invalidate).toHaveBeenCalledTimes(1)
    set({ kind: 'failed', message: 'child exited' })
    expect(invalidate.mock.calls).toEqual([[1], [2]])
  })

  it('preserves the typed original startup precondition failure', async () => {
    const { owner, start, set } = fixture()
    const failure = Object.assign(new Error('selected version missing'), {
      code: 'runtime.worktree_invalid'
    })
    start.mockImplementationOnce(async () => {
      set({ kind: 'starting' })
      await Promise.resolve()
      set({ kind: 'stopped' })
      throw failure
    })
    await expect(owner.connect(new AbortController().signal)).rejects.toBe(failure)
  })

  it('times out waiting for a real announcement and ignores a later event for that caller', async () => {
    vi.useFakeTimers()
    const { owner, set, start } = fixture({ kind: 'starting' })
    const pending = owner.connect(new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'p2p.runtime_timeout' })
    await vi.advanceTimersByTimeAsync(70_000)
    await rejected
    set({ kind: 'running', url })
    expect(start).not.toHaveBeenCalled()
    expect(await owner.connect(new AbortController().signal)).toEqual({ generation: 1, url })
  })

  it('removes listeners on close and cannot revive from later child state', async () => {
    const { owner, set, invalidate } = fixture({ kind: 'starting' })
    const pending = owner.connect(new AbortController().signal)
    owner.close()
    await expect(pending).rejects.toMatchObject({ code: 'p2p.runtime_owner_closed' })
    set({ kind: 'running', url })
    await expect(owner.connect(new AbortController().signal)).rejects.toMatchObject({
      code: 'p2p.runtime_owner_closed'
    })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
