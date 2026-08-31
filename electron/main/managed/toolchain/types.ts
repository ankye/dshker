/** A stable three-component semantic version with no prerelease identifier. */
export interface ToolchainVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly text: string
}

/** File identity used to detect replacement or mutation after executable registration. */
export interface ToolchainExecutableFingerprint {
  readonly device: number
  readonly inode: number
  readonly mode: number
  readonly size: number
  readonly modifiedAtMilliseconds: number
  readonly changedAtMilliseconds: number
}

/** An explicitly selected Node executable with its immutable registration observation. */
export interface NodeExecutableRegistration {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly fingerprint: ToolchainExecutableFingerprint
  readonly version: ToolchainVersion
}

/** The only two explicit process launch forms accepted for a pnpm entry. */
export type PnpmExecutableLauncher =
  | { readonly kind: 'native' }
  | { readonly kind: 'node-script'; readonly node: NodeExecutableRegistration }

/** An explicitly selected pnpm entry with its immutable registration observation. */
export interface PnpmExecutableRegistration {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly fingerprint: ToolchainExecutableFingerprint
  readonly launcher: PnpmExecutableLauncher
  readonly version: ToolchainVersion
}

/** An explicit, already-approved context for a shell-free tool probe. */
export interface ToolchainProcessContext {
  readonly workingDirectory: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMilliseconds: number
  readonly maximumOutputBytes: number
  readonly signal?: AbortSignal
}

/** An explicitly isolated pnpm probe with no ambient or project configuration. */
export interface PnpmProbeContext extends ToolchainProcessContext {
  /** A zero-length regular file used as the only user and global npm configuration. */
  readonly configurationFilePath: string
}

/** A bounded observation returned from a direct version probe. */
export interface ToolchainProbeResult {
  readonly operation: 'node.version_probe' | 'pnpm.version_probe'
  readonly executablePath: string
  readonly arguments: readonly string[]
  readonly workingDirectory: string
  readonly environmentNames: readonly string[]
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMilliseconds: number
}

/** One comparator accepted from an `engines.node` declaration. */
export interface NodeVersionComparator {
  readonly operator: '>' | '>=' | '<' | '<=' | '=' | '^' | '~'
  readonly version: ToolchainVersion
  readonly precision: 1 | 2 | 3
}

/** An OR expression of AND-ed Node version comparator sets. */
export interface NodeVersionRange {
  readonly text: string
  readonly alternatives: readonly (readonly NodeVersionComparator[])[]
}

/** Exact pnpm identity declared by a checkout's `packageManager` field. */
export interface PnpmPackageManagerDeclaration {
  readonly text: string
  readonly version: ToolchainVersion
}

/** The complete toolchain requirements taken directly from one selected checkout. */
export interface CheckoutToolchainRequirements {
  readonly worktreePath: string
  readonly packageManifestPath: string
  readonly nodeRange: NodeVersionRange
  readonly pnpm: PnpmPackageManagerDeclaration
}
