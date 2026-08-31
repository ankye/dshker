/** Stable, renderer-safe failures from explicit Node and pnpm preflight. */
export type ToolchainRuntimeErrorCode =
  | 'toolchain.executable_path_invalid'
  | 'toolchain.executable_unavailable'
  | 'toolchain.executable_invalid'
  | 'toolchain.executable_changed'
  | 'toolchain.probe_context_invalid'
  | 'toolchain.probe_isolation_invalid'
  | 'toolchain.probe_timeout'
  | 'toolchain.probe_cancelled'
  | 'toolchain.probe_output_limit'
  | 'toolchain.probe_failed'
  | 'toolchain.version_invalid'
  | 'toolchain.package_manifest_missing'
  | 'toolchain.package_manifest_invalid'
  | 'toolchain.node_requirement_missing'
  | 'toolchain.node_requirement_invalid'
  | 'toolchain.node_version_mismatch'
  | 'toolchain.package_manager_missing'
  | 'toolchain.package_manager_invalid'
  | 'toolchain.pnpm_version_mismatch'

/** Values safe to include in persisted or renderer-visible diagnostics. */
export type ToolchainRuntimeErrorDetail = string | number | boolean | readonly string[]

/** A typed error that intentionally omits raw paths and ambient environment values. */
export class ToolchainRuntimeError extends Error {
  readonly code: ToolchainRuntimeErrorCode
  readonly details: Readonly<Record<string, ToolchainRuntimeErrorDetail>>

  constructor(
    code: ToolchainRuntimeErrorCode,
    message: string,
    details: Readonly<Record<string, ToolchainRuntimeErrorDetail>> = {}
  ) {
    super(message)
    this.name = 'ToolchainRuntimeError'
    this.code = code
    this.details = details
  }
}

/** Converts an unknown lower-level error into a bounded toolchain failure. */
export function toolchainRuntimeFailure(
  code: ToolchainRuntimeErrorCode,
  message: string,
  cause: unknown,
  details: Readonly<Record<string, ToolchainRuntimeErrorDetail>> = {}
): ToolchainRuntimeError {
  return new ToolchainRuntimeError(code, message, {
    ...details,
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}
