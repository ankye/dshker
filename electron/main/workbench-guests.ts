import { randomBytes } from 'node:crypto'
import type { IpcMain, IpcMainEvent, WebContents } from 'electron'
import {
  WORKBENCH_CHANNELS,
  isWorkbenchReply,
  isWorkbenchRequest,
  type WorkbenchRequest,
  type WorkbenchSelection
} from '../../packages/dshker-workbench-client/src/protocol'
import { WorkbenchError } from '../../packages/dshker-workbench-client/src/navigation'

export interface WorkbenchGuestScope {
  readonly computerId: string
  readonly attemptId: string
  readonly runtimeGeneration: number
  readonly origin: string
}

interface Pending {
  readonly request: WorkbenchRequest
  readonly finish: (selection?: WorkbenchSelection, error?: WorkbenchError) => void
}

interface Registration {
  readonly guest: WebContents
  readonly scope: WorkbenchGuestScope
  sequence: number
  ready: boolean
  pending?: Pending
  remove?: () => void
}

/** Owns navigation admission for explicitly registered guest/runtime identities. */
export class WorkbenchGuests {
  readonly #records = new Map<number, Registration>()
  readonly #ipc: Pick<IpcMain, 'on' | 'removeListener'>

  constructor(ipc: Pick<IpcMain, 'on' | 'removeListener'>) {
    this.#ipc = ipc
    ipc.on(WORKBENCH_CHANNELS.ready, this.#ready)
    ipc.on(WORKBENCH_CHANNELS.reply, this.#reply)
  }

  register(guest: WebContents, scope: WorkbenchGuestScope): () => void {
    let origin: URL
    try {
      origin = new URL(scope.origin)
    } catch {
      throw new WorkbenchError('workbench.unavailable')
    }
    if (
      guest.isDestroyed() ||
      this.#records.has(guest.id) ||
      origin.origin !== scope.origin ||
      !['http:', 'https:'].includes(origin.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      !scope.computerId ||
      !scope.attemptId ||
      !Number.isSafeInteger(scope.runtimeGeneration) ||
      scope.runtimeGeneration < 1
    )
      throw new WorkbenchError('workbench.unavailable')
    const record: Registration = {
      guest,
      scope: Object.freeze({ ...scope }),
      sequence: 0,
      ready: false
    }
    this.#records.set(guest.id, record)
    const invalidate = (): void => {
      record.ready = false
      const pending = record.pending
      pending?.finish(undefined, new WorkbenchError('workbench.cancelled'))
      if (pending && !guest.isDestroyed()) {
        try {
          guest.send(WORKBENCH_CHANNELS.request, { ...pending.request, operation: 'cancel' })
        } catch {
          record.ready = false
        }
      }
    }
    const navigate = (
      _event: unknown,
      _url: string,
      _inPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame) invalidate()
    }
    const remove = (): void => {
      invalidate()
      if (this.#records.get(guest.id) === record) this.#records.delete(guest.id)
      guest.removeListener('did-start-navigation', navigate)
      guest.removeListener('destroyed', remove)
    }
    guest.on('did-start-navigation', navigate)
    guest.once('destroyed', remove)
    record.remove = remove
    return remove
  }

  request(
    guestId: number,
    scope: WorkbenchGuestScope,
    operation: 'navigate' | 'selection',
    target: WorkbenchRequest['target'],
    signal: AbortSignal
  ): Promise<WorkbenchSelection> {
    const record = this.#records.get(guestId)
    if (
      !record ||
      !record.ready ||
      !this.#sameScope(record.scope, scope) ||
      !this.#currentOrigin(record)
    )
      return Promise.reject(new WorkbenchError('workbench.unavailable'))
    if (record.pending) return Promise.reject(new WorkbenchError('workbench.busy'))
    const request: WorkbenchRequest = {
      version: 1,
      requestId: randomBytes(16).toString('hex'),
      sequence: ++record.sequence,
      operation,
      target: { ...target }
    }
    if (!isWorkbenchRequest(request))
      return Promise.reject(new WorkbenchError('workbench.invalid_request'))
    if (signal.aborted) return Promise.reject(new WorkbenchError('workbench.cancelled'))
    return new Promise((resolve, reject) => {
      const cancelGuest = (): void => {
        if (record.guest.isDestroyed()) return
        try {
          record.guest.send(WORKBENCH_CHANNELS.request, { ...request, operation: 'cancel' })
        } catch {
          record.ready = false
        }
      }
      const timer = setTimeout(() => {
        finish(undefined, new WorkbenchError('workbench.timeout'))
        cancelGuest()
      }, 10_000)
      const abort = (): void => {
        finish(undefined, new WorkbenchError('workbench.cancelled'))
        cancelGuest()
      }
      const finish = (selection?: WorkbenchSelection, error?: WorkbenchError): void => {
        if (record.pending?.request !== request) return
        delete record.pending
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else if (selection) resolve(selection)
        else reject(new WorkbenchError('workbench.selection_unconfirmed'))
      }
      record.pending = { request, finish }
      signal.addEventListener('abort', abort, { once: true })
      try {
        record.guest.send(WORKBENCH_CHANNELS.request, request)
      } catch {
        finish(undefined, new WorkbenchError('workbench.unavailable'))
      }
    })
  }

  dispose(): void {
    this.#ipc.removeListener(WORKBENCH_CHANNELS.ready, this.#ready)
    this.#ipc.removeListener(WORKBENCH_CHANNELS.reply, this.#reply)
    for (const record of [...this.#records.values()]) record.remove?.()
    this.#records.clear()
  }

  #sameScope(left: WorkbenchGuestScope, right: WorkbenchGuestScope): boolean {
    return (
      left.computerId === right.computerId &&
      left.attemptId === right.attemptId &&
      left.runtimeGeneration === right.runtimeGeneration &&
      left.origin === right.origin
    )
  }

  #currentOrigin(record: Registration): boolean {
    if (record.guest.isDestroyed()) return false
    try {
      return new URL(record.guest.getURL()).origin === record.scope.origin
    } catch {
      return false
    }
  }

  #admit(event: IpcMainEvent): Registration | undefined {
    const record = this.#records.get(event.sender.id)
    if (
      !record ||
      event.sender !== record.guest ||
      event.senderFrame !== record.guest.mainFrame ||
      !this.#currentOrigin(record)
    )
      return undefined
    return record
  }

  readonly #ready = (event: IpcMainEvent, value: unknown): void => {
    const record = this.#admit(event)
    if (!record) return
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 2 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('available' in value) ||
      typeof value.available !== 'boolean'
    ) {
      record.ready = false
      record.pending?.finish(undefined, new WorkbenchError('workbench.unavailable'))
      return
    }
    record.ready = value.available
    if (!record.ready)
      record.pending?.finish(undefined, new WorkbenchError('workbench.unavailable'))
  }

  readonly #reply = (event: IpcMainEvent, value: unknown): void => {
    const record = this.#admit(event)
    if (!record?.pending) return
    if (!isWorkbenchReply(value)) {
      record.pending.finish(undefined, new WorkbenchError('workbench.invalid_request'))
      return
    }
    const { request, finish } = record.pending
    if (value.requestId !== request.requestId || value.sequence !== request.sequence) return
    if (!value.ok) {
      finish(undefined, new WorkbenchError(value.code))
      return
    }
    const { selection } = value
    if (
      selection.workspaceId !== request.target.workspaceId ||
      selection.sessionId !== request.target.sessionId ||
      selection.path !== request.target.path
    ) {
      finish(undefined, new WorkbenchError('workbench.selection_unconfirmed'))
      return
    }
    finish(selection)
  }
}
