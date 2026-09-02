/** Stable failures from the launcher-owned managed-root subsystem. */
export type ManagedRootErrorCode =
  | 'managed.invalid_record'
  | 'managed.unsupported_version'
  | 'managed.missing_registry'
  | 'managed.missing_bootstrap_locator'
  | 'managed.invalid_bootstrap_locator'
  | 'managed.root_path_invalid'
  | 'managed.root_not_directory'
  | 'managed.root_not_writable'
  | 'managed.root_not_empty'
  | 'managed.root_symbolic_link'
  | 'managed.root_overlap'
  | 'managed.dsh_runtime_overlap'
  | 'managed.namespace_invalid'
  | 'managed.namespace_overlap'
  | 'managed.working_directory_invalid'
  | 'managed.selection_invalid'
  | 'managed.selection_expired'
  | 'managed.selection_cancelled'
  | 'managed.setup_already_complete'
  | 'managed.workspace_not_found'
  | 'managed.workspace_exists'
  | 'managed.operation_in_progress'
  | 'managed.persistence_failed'
  | 'managed.executable_selection_invalid'
  | 'managed.toolchain_invalid'
  | 'managed.toolchain_not_found'
  | 'managed.installation_not_found'
  | 'managed.installation_exists'
  | 'managed.git_remote_invalid'
  | 'managed.git_revision_invalid'
  | 'managed.git_operation_failed'
  | 'managed.bundled_seed_unavailable'
  | 'managed.bundled_seed_invalid'
  | 'managed.harness_launch_failed'
  | 'managed.harness_launch_in_progress'
  | 'managed.harness_busy_running'
  | 'managed.harness_worktree_invalid'
  | 'managed.harness_input_invalid'
  | 'managed.harness_plugin_operation_failed'

/** Carries a safe, typed failure without serializing filesystem or secret data by default. */
export class ManagedRootError extends Error {
  readonly code: ManagedRootErrorCode
  readonly details: Readonly<Record<string, string | number | boolean>>

  constructor(
    code: ManagedRootErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {}
  ) {
    super(message)
    this.name = 'ManagedRootError'
    this.code = code
    this.details = details
  }
}
