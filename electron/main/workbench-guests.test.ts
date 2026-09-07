import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchGuests, type WorkbenchGuestScope } from './workbench-guests'
import {
  WORKBENCH_CHANNELS,
  type WorkbenchRequest
} from '../../packages/dshker-workbench-client/src/protocol'

const scope: WorkbenchGuestScope = {
  computerId: 'computer-A',
  attemptId: 'attempt-A',
  runtimeGeneration: 2,
  origin: 'http://127.0.0.1:40001'
}
const target = { workspaceId: 'workspace-A', sessionId: 'session-A', path: '/remote/project' }

function fixture() {
  const ipc = new EventEmitter()
  const emitter = new EventEmitter()
  const frame = { url: scope.origin }
  const send = vi.fn()
  const guest = Object.assign(emitter, {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => `${scope.origin}/`,
    send
  }) as unknown as WebContents
  const controller = new WorkbenchGuests(ipc as unknown as IpcMain)
  const unregister = controller.register(guest, scope)
  const event = { sender: guest, senderFrame: frame }
  const ready = () => ipc.emit(WORKBENCH_CHANNELS.ready, event, { version: 1, available: true })
  const sent = (): WorkbenchRequest => send.mock.calls.at(-1)![1]
  const reply = (request: WorkbenchRequest, selection = target, source = event) =>
    ipc.emit(WORKBENCH_CHANNELS.reply, source, {
      version: 1,
      requestId: request.requestId,
      sequence: request.sequence,
      ok: true,
      selection
    })
  return { ipc, guest, emitter, controller, unregister, event, ready, sent, reply, send }
}

describe('workbench guest admission', () => {
  it('requires a ready client and exact registered scope', async () => {
    const state = fixture()
    try {
      await expect(
        state.controller.request(1, scope, 'navigate', target, new AbortController().signal)
      ).rejects.toThrow('workbench.unavailable')
      state.ready()
      for (const changed of [
        { ...scope, computerId: 'other' },
        { ...scope, runtimeGeneration: 3 },
        { ...scope, attemptId: 'other' }
      ]) {
        await expect(
          state.controller.request(1, changed, 'navigate', target, new AbortController().signal)
        ).rejects.toThrow('workbench.unavailable')
      }
      expect(state.send).not.toHaveBeenCalled()
    } finally {
      state.controller.dispose()
    }
  })

  it('admits exact identity readback but ignores foreign frames and stale receipts', async () => {
    const state = fixture()
    try {
      state.ready()
      const result = state.controller.request(
        1,
        scope,
        'navigate',
        target,
        new AbortController().signal
      )
      const sent = state.sent()
      let settled = false
      void result.then(() => {
        settled = true
      })
      state.reply(sent, target, { ...state.event, senderFrame: { url: scope.origin } })
      state.reply({ ...sent, sequence: sent.sequence + 1 })
      await Promise.resolve()
      expect(settled).toBe(false)
      state.reply(sent)
      await expect(result).resolves.toEqual(target)
      expect(sent.target).toEqual(target)
      expect(sent.requestId).toMatch(/^[a-f0-9]{32}$/)
      expect(Object.keys(sent).sort()).toEqual([
        'operation',
        'requestId',
        'sequence',
        'target',
        'version'
      ])
    } finally {
      state.controller.dispose()
    }
  })

  it('rejects mismatched readback and duplicate concurrent navigation', async () => {
    const state = fixture()
    try {
      state.ready()
      const result = state.controller.request(
        1,
        scope,
        'navigate',
        target,
        new AbortController().signal
      )
      await expect(
        state.controller.request(1, scope, 'navigate', target, new AbortController().signal)
      ).rejects.toThrow('workbench.busy')
      state.reply(state.sent(), { ...target, path: '/other' })
      await expect(result).rejects.toThrow('workbench.selection_unconfirmed')
    } finally {
      state.controller.dispose()
    }
  })

  it('cancels on abort and forwards cancellation to the same guest request', async () => {
    const state = fixture()
    try {
      state.ready()
      const abort = new AbortController()
      const result = state.controller.request(1, scope, 'navigate', target, abort.signal)
      const sent = state.sent()
      abort.abort()
      await expect(result).rejects.toThrow('workbench.cancelled')
      expect(state.sent()).toEqual({ ...sent, operation: 'cancel' })
      state.reply(sent)
      const readback = state.controller.request(
        1,
        scope,
        'selection',
        target,
        new AbortController().signal
      )
      const next = state.sent()
      expect(next.sequence).toBe(sent.sequence + 1)
      expect(next.requestId).not.toBe(sent.requestId)
      state.reply(next)
      await expect(readback).resolves.toEqual(target)
    } finally {
      state.controller.dispose()
    }
  })

  it('invalidates document readiness on navigation and removes every lifecycle listener', async () => {
    const state = fixture()
    state.ready()
    const result = state.controller.request(
      1,
      scope,
      'navigate',
      target,
      new AbortController().signal
    )
    state.emitter.emit('did-start-navigation', {}, scope.origin, false, true)
    await expect(result).rejects.toThrow('workbench.cancelled')
    await expect(
      state.controller.request(1, scope, 'navigate', target, new AbortController().signal)
    ).rejects.toThrow('workbench.unavailable')
    state.controller.dispose()
    expect(state.emitter.listenerCount('did-start-navigation')).toBe(0)
    expect(state.emitter.listenerCount('destroyed')).toBe(0)
    expect(state.ipc.eventNames()).toEqual([])
  })

  it('does not make foreign ready messages authoritative', async () => {
    const state = fixture()
    try {
      state.ipc.emit(WORKBENCH_CHANNELS.ready, { ...state.event, senderFrame: {} }, { version: 1 })
      await expect(
        state.controller.request(1, scope, 'navigate', target, new AbortController().signal)
      ).rejects.toThrow('workbench.unavailable')
      state.ipc.emit(WORKBENCH_CHANNELS.ready, state.event, { version: 2 })
      await expect(
        state.controller.request(1, scope, 'navigate', target, new AbortController().signal)
      ).rejects.toThrow('workbench.unavailable')
    } finally {
      state.controller.dispose()
    }
  })
})
