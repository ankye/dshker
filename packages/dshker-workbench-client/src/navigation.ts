import type { WorkbenchErrorCode, WorkbenchRequest, WorkbenchSelection } from './protocol'

/** Narrow projection of the public DSH services; the adapter binds their real fields. */
export interface NavigationOwner {
  refreshSessions(): Promise<void>
  targetState(target: WorkbenchRequest['target']): 'pending' | 'ready' | 'missing' | 'mismatch'
  subscribe(listener: () => void): () => void
  openSession(sessionId: string): void
  selected(): WorkbenchSelection | undefined
}

export class WorkbenchError extends Error {
  constructor(readonly code: WorkbenchErrorCode) {
    super(code)
  }
}

/** Resolve one navigation without creating sessions or writing private client stores. */
export async function navigateWorkbench(
  owner: NavigationOwner,
  request: WorkbenchRequest,
  signal: AbortSignal
): Promise<WorkbenchSelection> {
  signal.throwIfAborted()
  if (request.operation === 'cancel') throw new WorkbenchError('workbench.invalid_request')
  if (request.operation === 'navigate') {
    await cancelled(owner.refreshSessions(), signal)
    await waitForTarget(owner, request.target, signal)
    signal.throwIfAborted()
    owner.openSession(request.target.sessionId)
  }
  signal.throwIfAborted()
  const selection = owner.selected()
  if (!selection || !sameTarget(selection, request.target)) {
    throw new WorkbenchError('workbench.selection_unconfirmed')
  }
  return selection
}

function sameTarget(actual: WorkbenchSelection, expected: WorkbenchRequest['target']): boolean {
  return (
    actual.workspaceId === expected.workspaceId &&
    actual.sessionId === expected.sessionId &&
    actual.path === expected.path
  )
}

function waitForTarget(
  owner: NavigationOwner,
  target: WorkbenchRequest['target'],
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => finish(new WorkbenchError('workbench.cancelled'))
    const read = (): void => {
      try {
        const state = owner.targetState(target)
        if (state === 'ready') finish()
        if (state === 'missing') finish(new WorkbenchError('workbench.session_missing'))
        if (state === 'mismatch') finish(new WorkbenchError('workbench.workspace_mismatch'))
      } catch {
        finish(new WorkbenchError('workbench.unavailable'))
      }
    }
    unsubscribe = owner.subscribe(read)
    if (settled) {
      unsubscribe()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else read()
  })
}

function cancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new WorkbenchError('workbench.cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
