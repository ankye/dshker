import { PeerHelperError } from '../p2p/wire'

/** Stable failures from the independent runtime owner, not the DSH checkout. */
export const RUNTIME_OWNER_ERROR_MESSAGES = {
  'runtime.owner_unavailable':
    'The runtime owner is unavailable. DSH may still be running; inspect owner diagnostics before taking action.',
  'runtime.owner_identity_mismatch':
    'Runtime owner identity verification failed. The request was refused; verify the registered owner and roots.',
  'runtime.owner_record_invalid':
    'The runtime owner record is invalid. The request was refused; preserve the record and inspect diagnostics.',
  'runtime.owner_protocol_unsupported':
    'The runtime owner protocol is incompatible. The request was refused; verify matching Launcher and core versions.',
  'runtime.owner_configuration_invalid':
    'The runtime owner configuration is invalid. The request was refused; verify explicitly registered roots and environment.',
  'runtime.owner_shutdown_failed':
    'Runtime owner shutdown was not confirmed. DSH may still be running; inspect diagnostics before taking action.'
} as const

export type RuntimeOwnerErrorCode = keyof typeof RUNTIME_OWNER_ERROR_MESSAGES

/** Stable failures from the Launcher-owned Harness child runtime supervisor. */
export type ManagedHarnessRuntimeErrorCode =
  | RuntimeOwnerErrorCode
  | 'runtime.input_invalid'
  | 'runtime.node_invalid'
  | 'runtime.worktree_invalid'
  | 'runtime.descriptor_invalid'
  | 'runtime.descriptor_write_failed'
  | 'runtime.spawn_failed'
  | 'runtime.child_unavailable'
  | 'runtime.protocol_invalid'
  | 'runtime.protocol_mismatch'
  | 'runtime.handshake_timeout'
  | 'runtime.ready_timeout'
  | 'runtime.shutdown_timeout'
  | 'runtime.child_crashed'
  | 'runtime.operation_in_progress'
  /** A version or plugin change was refused because DSH Web is still running. */
  | 'runtime.busy_running'
  /** A launch port is held by a process the Launcher may not stop. */
  | 'runtime.port_in_use'
  /** The DSH CLI refused a plugin install or uninstall. */
  | 'runtime.plugin_operation_failed'
  /** The selected core and installed profile plugin peer ranges do not overlap. */
  | 'runtime.plugin_incompatible'
  /** The persisted active-version pointer exists but is not a valid record. */
  | 'runtime.version_pointer_invalid'
  | 'runtime.not_found'

/** A non-secret error that identifies why one managed Harness generation cannot run. */
export class ManagedHarnessRuntimeError extends Error {
  readonly code: ManagedHarnessRuntimeErrorCode
  readonly details: Readonly<Record<string, string | number | boolean>>

  constructor(
    code: ManagedHarnessRuntimeErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {}
  ) {
    super(message)
    this.name = 'ManagedHarnessRuntimeError'
    this.code = code
    this.details = details
  }
}

/** Admit only known typed owner errors and discard all private error details. */
export function runtimeOwnerError(error: unknown): ManagedHarnessRuntimeError | undefined {
  if (!(error instanceof PeerHelperError) && !(error instanceof ManagedHarnessRuntimeError)) {
    return undefined
  }
  if (!Object.prototype.hasOwnProperty.call(RUNTIME_OWNER_ERROR_MESSAGES, error.code)) {
    return undefined
  }
  const code = error.code as RuntimeOwnerErrorCode
  return new ManagedHarnessRuntimeError(code, RUNTIME_OWNER_ERROR_MESSAGES[code])
}
