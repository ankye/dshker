import { describe, expect, it, vi } from 'vitest'
import { navigateWorkbench, type NavigationOwner } from '../src/navigation'
import { bindWorkbench } from '../src/channel'
import {
  isWorkbenchRequest,
  type WorkbenchRequest,
  type WorkbenchReply,
  type WorkbenchGuestBridge
} from '../src/protocol'

const request: WorkbenchRequest = {
  version: 1,
  requestId: 'a'.repeat(32),
  sequence: 1,
  operation: 'navigate',
  target: { workspaceId: 'workspace-A', sessionId: 'session-A', path: '/remote/project' }
}

function fixture() {
  const listeners = new Set<() => void>()
  let selected: WorkbenchRequest['target'] | undefined
  let state: ReturnType<NavigationOwner['targetState']> = 'ready'
  const owner: NavigationOwner = {
    refreshSessions: vi.fn(async () => {}),
    targetState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    openSession: vi.fn(() => {
      selected = request.target
    }),
    selected: () => selected
  }
  return {
    owner,
    listeners,
    setState: (next: typeof state) => {
      state = next
      for (const listener of listeners) listener()
    }
  }
}

describe('workbench public navigation', () => {
  it('refreshes, selects and reads back exact remote identity', async () => {
    const { owner } = fixture()
    const actual = await navigateWorkbench(owner, request, new AbortController().signal)
    expect(actual).toEqual(request.target)
    expect(owner.refreshSessions).toHaveBeenCalledOnce()
    expect(owner.openSession).toHaveBeenCalledExactlyOnceWith('session-A')
  })

  it.each(['missing', 'mismatch'] as const)('rejects %s without switching', async (state) => {
    const { owner, setState, listeners } = fixture()
    setState(state)
    await expect(navigateWorkbench(owner, request, new AbortController().signal)).rejects.toThrow(
      state === 'missing' ? 'workbench.session_missing' : 'workbench.workspace_mismatch'
    )
    expect(owner.openSession).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('waits for workspace membership and cancels without a late switch', async () => {
    const { owner, setState, listeners } = fixture()
    setState('pending')
    const controller = new AbortController()
    const result = navigateWorkbench(owner, request, controller.signal)
    const rejected = expect(result).rejects.toThrow('workbench.cancelled')
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    controller.abort()
    await rejected
    setState('ready')
    expect(owner.openSession).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('does not claim success when the owner selects a different session', async () => {
    const { owner } = fixture()
    owner.selected = () => ({ ...request.target, sessionId: 'other' })
    await expect(navigateWorkbench(owner, request, new AbortController().signal)).rejects.toThrow(
      'workbench.selection_unconfirmed'
    )
  })

  it('reads selection without creating or switching anything', async () => {
    const { owner } = fixture()
    owner.selected = () => request.target
    await expect(
      navigateWorkbench(owner, { ...request, operation: 'selection' }, new AbortController().signal)
    ).resolves.toEqual(request.target)
    expect(owner.openSession).not.toHaveBeenCalled()
    expect(owner.refreshSessions).not.toHaveBeenCalled()
  })

  it('validates exact bounded wire fields', () => {
    expect(isWorkbenchRequest(request)).toBe(true)
    for (const invalid of [
      null,
      {},
      { ...request, version: 2 },
      { ...request, sequence: 0 },
      { ...request, executable: '/bin/sh' },
      { ...request, target: { ...request.target, path: '' } },
      { ...request, target: { ...request.target, path: 'a\0b' } }
    ]) {
      expect(isWorkbenchRequest(invalid)).toBe(false)
    }
  })
})

describe('workbench document lifecycle', () => {
  function channel() {
    const state = fixture()
    let listener: ((request: WorkbenchRequest) => void) | undefined
    const replies: WorkbenchReply[] = []
    const bridge: WorkbenchGuestBridge = {
      version: 1,
      onRequest: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      reply: (value) => replies.push(value)
    }
    return { ...state, bridge, replies, send: (value: WorkbenchRequest) => listener?.(value) }
  }

  it('cancels only the named active request without replaying navigation', async () => {
    const state = channel()
    state.setState('pending')
    const dispose = bindWorkbench(state.bridge, state.owner, 1000)
    try {
      state.send(request)
      await vi.waitFor(() => expect(state.listeners.size).toBe(1))
      state.send({ ...request, requestId: 'b'.repeat(32), operation: 'cancel' })
      expect(state.listeners.size).toBe(1)
      expect(state.replies[0]).toMatchObject({ code: 'workbench.stale_request' })
      state.send({ ...request, operation: 'cancel' })
      await vi.waitFor(() => expect(state.replies).toHaveLength(2))
      expect(state.replies[1]).toMatchObject({
        requestId: request.requestId,
        code: 'workbench.cancelled'
      })
      state.setState('ready')
      expect(state.owner.openSession).not.toHaveBeenCalled()
      expect(state.listeners.size).toBe(0)
    } finally {
      dispose()
    }
  })

  it('rejects replays and concurrent requests, then permits explicit readback', async () => {
    const state = channel()
    state.setState('pending')
    const dispose = bindWorkbench(state.bridge, state.owner, 1000)
    try {
      state.send(request)
      state.send(request)
      state.send({ ...request, requestId: 'b'.repeat(32), sequence: 2 })
      expect(state.replies).toMatchObject([
        { ok: false, code: 'workbench.stale_request', sequence: 1 },
        { ok: false, code: 'workbench.busy', sequence: 2 }
      ])
      state.setState('ready')
      await vi.waitFor(() => expect(state.replies).toHaveLength(3))
      expect(state.replies[2]).toEqual({
        version: 1,
        requestId: request.requestId,
        sequence: 1,
        ok: true,
        selection: request.target
      })
      state.send({ ...request, sequence: 3, operation: 'selection' })
      await vi.waitFor(() => expect(state.replies).toHaveLength(4))
      expect(state.owner.openSession).toHaveBeenCalledOnce()
    } finally {
      dispose()
    }
  })

  it('times out pending membership and suppresses replies after unload', async () => {
    const state = channel()
    state.setState('pending')
    const dispose = bindWorkbench(state.bridge, state.owner, 10)
    state.send(request)
    await vi.waitFor(() => expect(state.replies).toHaveLength(1))
    expect(state.replies[0]).toMatchObject({
      ok: false,
      code: 'workbench.timeout',
      requestId: request.requestId
    })
    state.send({ ...request, sequence: 2 })
    dispose()
    state.setState('ready')
    await Promise.resolve()
    expect(state.replies).toHaveLength(1)
    expect(state.owner.openSession).not.toHaveBeenCalled()
    expect(state.listeners.size).toBe(0)
  })
})
