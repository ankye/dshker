import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  formatChildGone,
  formatMainFault,
  formatRendererGone,
  installFaultTrace,
  type FaultTraceApp,
  type FaultTraceProcess
} from './main-faults'

function fakeApp() {
  const emitter = new EventEmitter()
  const exit = vi.fn()
  return {
    app: Object.assign(emitter, { exit }) as unknown as FaultTraceApp,
    exit,
    emit: emitter.emit.bind(emitter)
  }
}

function fakeProcess() {
  const emitter = new EventEmitter()
  return {
    faults: emitter as unknown as FaultTraceProcess,
    emit: emitter.emit.bind(emitter)
  }
}

describe('main fault trace', () => {
  /**
   * The report that prompted this: a window vanished and the only evidence was the
   * user's word for it. Deaths the application survives are recorded, and an
   * uncaught exception is recorded before the process ends the way it would have.
   */
  it('records a renderer that died with the reason and the page it was showing', () => {
    const written: string[] = []
    const { app, emit } = fakeApp()
    installFaultTrace({ app, faults: fakeProcess().faults, write: (line) => written.push(line) })

    emit(
      'render-process-gone',
      {},
      { getURL: () => 'http://127.0.0.1:31888/', getType: () => 'webview' },
      { reason: 'crashed', exitCode: 133 }
    )

    expect(written).toHaveLength(1)
    expect(written[0]).toContain('renderer gone: crashed (exit 133)')
    expect(written[0]).toContain('http://127.0.0.1:31888/')
  })

  it('names a child process that died, and leaves the application running', () => {
    const written: string[] = []
    const { app, exit, emit } = fakeApp()
    installFaultTrace({ app, faults: fakeProcess().faults, write: (line) => written.push(line) })

    emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })

    expect(written[0]).toContain('child process gone: GPU (crashed, exit 1)')
    expect(exit).not.toHaveBeenCalled()
  })

  it('records an uncaught exception and then ends the process deliberately', () => {
    const written: string[] = []
    const { app, exit } = fakeApp()
    const { faults, emit } = fakeProcess()
    installFaultTrace({ app, faults, write: (line) => written.push(line) })

    emit('uncaughtException', new Error('boom'))

    expect(written[0]).toContain('main process uncaughtException: Error: boom')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('records a rejection without ending the process', () => {
    const written: string[] = []
    const { app, exit } = fakeApp()
    const { faults, emit } = fakeProcess()
    installFaultTrace({ app, faults, write: (line) => written.push(line) })

    emit('unhandledRejection', { code: 'E_PEER' })

    expect(written[0]).toContain('main process unhandledRejection: {"code":"E_PEER"}')
    expect(exit).not.toHaveBeenCalled()
  })

  it('names the window type when a renderer that never navigated dies', () => {
    expect(
      formatRendererGone(
        { reason: 'oom', exitCode: 5 },
        { getURL: () => '', getType: () => 'window' }
      )
    ).toBe('renderer gone: oom (exit 5) while showing window')
  })

  it('prefers a child process name over its type when one is reported', () => {
    expect(
      formatChildGone({ type: 'Utility', reason: 'killed', exitCode: 0, serviceName: 'audio' })
    ).toBe('child process gone: Utility audio (killed, exit 0)')
  })

  it('survives a fault value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatMainFault('unhandledRejection', circular)).toContain(
      'main process unhandledRejection:'
    )
  })
})
