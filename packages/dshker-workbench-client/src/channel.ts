import {
  isWorkbenchRequest,
  type WorkbenchGuestBridge,
  type WorkbenchReply,
  type WorkbenchRequest
} from './protocol'
import { navigateWorkbench, WorkbenchError, type NavigationOwner } from './navigation'

/** Bind one document's navigation. Disposal cancels work and never replays a request. */
export function bindWorkbench(
  bridge: WorkbenchGuestBridge,
  owner: NavigationOwner,
  timeoutMs: number
): () => void {
  if (bridge.version !== 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new WorkbenchError('workbench.unavailable')
  let lastSequence = 0
  let current: AbortController | undefined
  let activeRequest: WorkbenchRequest | undefined
  let disposed = false
  const replyFailure = (
    request: WorkbenchRequest,
    code: Extract<WorkbenchReply, { ok: false }>['code']
  ): void => {
    if (!disposed)
      bridge.reply({
        version: 1,
        requestId: request.requestId,
        sequence: request.sequence,
        ok: false,
        code
      })
  }
  const unsubscribe = bridge.onRequest((request) => {
    if (disposed) return
    if (!isWorkbenchRequest(request)) throw new WorkbenchError('workbench.invalid_request')
    if (request.operation === 'cancel') {
      if (
        activeRequest?.requestId === request.requestId &&
        activeRequest.sequence === request.sequence
      )
        current?.abort()
      else replyFailure(request, 'workbench.stale_request')
      return
    }
    if (request.sequence <= lastSequence) {
      replyFailure(request, 'workbench.stale_request')
      return
    }
    lastSequence = request.sequence
    if (current) {
      replyFailure(request, 'workbench.busy')
      return
    }
    const operation = new AbortController()
    current = operation
    activeRequest = request
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      operation.abort()
    }, timeoutMs)
    void navigateWorkbench(owner, request, operation.signal)
      .then(
        (selection) => {
          if (!disposed)
            bridge.reply({
              version: 1,
              requestId: request.requestId,
              sequence: request.sequence,
              ok: true,
              selection
            })
        },
        (error: unknown) =>
          replyFailure(
            request,
            timedOut
              ? 'workbench.timeout'
              : error instanceof WorkbenchError
                ? error.code
                : 'workbench.unavailable'
          )
      )
      .finally(() => {
        clearTimeout(timer)
        if (current === operation) {
          current = undefined
          activeRequest = undefined
        }
      })
  })
  return () => {
    disposed = true
    unsubscribe()
    current?.abort()
  }
}
