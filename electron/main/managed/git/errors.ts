/** Stable, renderer-safe failures from the managed Git runtime. */
export type GitRuntimeErrorCode =
  | 'git.executable_invalid'
  | 'git.executable_changed'
  | 'git.executable_unavailable'
  | 'git.version_invalid'
  | 'git.version_unsupported'
  | 'git.command_invalid'
  | 'git.command_timeout'
  | 'git.command_cancelled'
  | 'git.command_output_limit'
  | 'git.command_failed'
  | 'git.remote_invalid'
  | 'git.remote_mismatch'
  | 'git.remote_missing'
  | 'git.repository_invalid'
  | 'git.repository_not_bare'
  | 'git.repository_dirty'
  | 'git.ref_invalid'
  | 'git.ref_missing'
  | 'git.ref_ambiguous'
  | 'git.ref_not_commit'
  | 'git.ref_rewritten'
  | 'git.managed_path_invalid'
  | 'git.managed_path_escape'
  | 'git.mirror_exists'
  | 'git.mirror_missing'
  | 'git.worktree_exists'
  | 'git.worktree_missing'
  | 'git.worktree_mismatch'
  | 'git.operation_locked'
  | 'git.operation_lock_lost'
  | 'git.operation_failed'

/** Data safe to render or persist in launcher diagnostics. */
export type GitRuntimeErrorDetail = string | number | boolean | readonly string[]

/** A typed failure that intentionally excludes raw filesystem and credential-bearing values. */
export class GitRuntimeError extends Error {
  readonly code: GitRuntimeErrorCode
  readonly details: Readonly<Record<string, GitRuntimeErrorDetail>>

  constructor(
    code: GitRuntimeErrorCode,
    message: string,
    details: Readonly<Record<string, GitRuntimeErrorDetail>> = {}
  ) {
    super(message)
    this.name = 'GitRuntimeError'
    this.code = code
    this.details = details
  }
}

/** Converts an unknown exception into a safe Git-runtime failure. */
export function gitRuntimeFailure(
  code: GitRuntimeErrorCode,
  message: string,
  cause: unknown,
  details: Readonly<Record<string, GitRuntimeErrorDetail>> = {}
): GitRuntimeError {
  return new GitRuntimeError(code, message, {
    ...details,
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}
