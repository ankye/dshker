/** Stable failures from the Launcher-owned Harness child runtime supervisor. */
export type ManagedHarnessRuntimeErrorCode =
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
  /** The DSH CLI refused a plugin install or uninstall. */
  | 'runtime.plugin_operation_failed'
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
