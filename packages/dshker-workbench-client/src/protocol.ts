/** Versioned, credential-free channel between one guest and its owning main process. */
export const WORKBENCH_BRIDGE_VERSION = 1 as const

export const WORKBENCH_CHANNELS = Object.freeze({
  request: 'dshker:workbench:request:v1',
  reply: 'dshker:workbench:reply:v1',
  ready: 'dshker:workbench:ready:v1'
})

export interface WorkbenchRequest {
  readonly version: 1
  readonly requestId: string
  readonly sequence: number
  readonly operation: 'navigate' | 'selection' | 'cancel'
  readonly target: {
    readonly workspaceId: string
    readonly sessionId: string
    readonly path: string
  }
}

export interface WorkbenchSelection {
  readonly workspaceId: string
  readonly sessionId: string
  readonly path: string
}

export type WorkbenchReply = {
  readonly version: 1
  readonly requestId: string
  readonly sequence: number
} & (
  | { readonly ok: true; readonly selection: WorkbenchSelection }
  | { readonly ok: false; readonly code: WorkbenchErrorCode }
)

export type WorkbenchErrorCode =
  | 'workbench.invalid_request'
  | 'workbench.stale_request'
  | 'workbench.busy'
  | 'workbench.unavailable'
  | 'workbench.cancelled'
  | 'workbench.timeout'
  | 'workbench.session_missing'
  | 'workbench.workspace_mismatch'
  | 'workbench.selection_unconfirmed'

/** The preload owns subscriptions; the page has no IPC channel selector. */
export interface WorkbenchGuestBridge {
  readonly version: 1
  onRequest(listener: (request: WorkbenchRequest) => void): () => void
  reply(result: WorkbenchReply): void
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

/** Validate requests crossing into the guest; no paths or identifiers are inferred. */
export function isWorkbenchRequest(value: unknown): value is WorkbenchRequest {
  if (!exact(value, ['version', 'requestId', 'sequence', 'operation', 'target'])) return false
  if (
    value.version !== WORKBENCH_BRIDGE_VERSION ||
    typeof value.requestId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.requestId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !['navigate', 'selection', 'cancel'].includes(value.operation as string) ||
    !exact(value.target, ['workspaceId', 'sessionId', 'path'])
  )
    return false
  const target = value.target
  return ['workspaceId', 'sessionId', 'path'].every((key) => {
    const field = target[key]
    return (
      typeof field === 'string' && field.length > 0 && field.length <= 4096 && !field.includes('\0')
    )
  })
}

/** Validate guest readback without trusting extra fields or arbitrary error text. */
export function isWorkbenchReply(value: unknown): value is WorkbenchReply {
  if (value === null || typeof value !== 'object') return false
  const success = (value as Record<string, unknown>).ok === true
  if (!exact(value, ['version', 'requestId', 'sequence', 'ok', success ? 'selection' : 'code']))
    return false
  if (value.ok !== true && value.ok !== false) return false
  if (success) {
    return isWorkbenchRequest({
      version: value.version,
      requestId: value.requestId,
      sequence: value.sequence,
      operation: 'selection',
      target: value.selection
    })
  }
  return (
    value.version === 1 &&
    typeof value.requestId === 'string' &&
    /^[a-f0-9]{32}$/.test(value.requestId) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    [
      'workbench.invalid_request',
      'workbench.stale_request',
      'workbench.busy',
      'workbench.unavailable',
      'workbench.cancelled',
      'workbench.timeout',
      'workbench.session_missing',
      'workbench.workspace_mismatch',
      'workbench.selection_unconfirmed'
    ].includes(value.code as string)
  )
}
