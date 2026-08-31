/** An exact full Git object identity used as a runtime version. */
export type GitCommitSha = string & { readonly __gitCommitSha: unique symbol }

/** A parsed dotted Git release version. */
export interface GitVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly text: string
}

/** A comparison floor declared by the launcher release rather than inferred at runtime. */
export interface GitToolPolicy {
  readonly minimumVersion: GitVersion
  readonly maximumExclusiveVersion: GitVersion
}

/** A pinned executable file identity. */
export interface GitExecutableFingerprint {
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly modifiedAtMilliseconds: number
}

/** A registered external Git executable with its realpath and identity pinned. */
export interface GitExecutableRegistration {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly fingerprint: GitExecutableFingerprint
  readonly version: GitVersion
}

/** Explicit, already-approved process context for one Git invocation. */
export interface GitExecutionContext {
  readonly workingDirectory: string
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMilliseconds: number
  readonly maximumOutputBytes: number
  readonly signal?: AbortSignal
}

/** One shell-free Git command declared by a named operation. */
export interface GitCommand {
  readonly operation: string
  readonly arguments: readonly string[]
}

/** Bounded, credential-redacted Git command observations. */
export interface GitCommandResult {
  readonly operation: string
  readonly executablePath: string
  readonly workingDirectory: string
  readonly environmentNames: readonly string[]
  readonly arguments: readonly string[]
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMilliseconds: number
}

/** The two production Git remote transports supported by the launcher. */
export type GitRemoteTransport = 'https' | 'ssh'

/** Canonical remote identity used for equality checks and persistence. */
export interface GitRemoteIdentity {
  readonly transport: GitRemoteTransport
  readonly host: string
  readonly effectivePort: number
  readonly sshUser?: string
  readonly repositoryPathKind: 'absolute' | 'relative'
  readonly repositoryPath: string
  readonly display: string
}

/** A validated remote as supplied by the user, safe to pass to Git unchanged. */
export interface GitRemoteSource {
  readonly declaredUrl: string
  readonly identity: GitRemoteIdentity
}

/** A named remote, with a separately validated immutable source identity. */
export interface GitNamedRemote {
  readonly name: string
  readonly source: GitRemoteSource
}

/** A selected remote-tracking branch, tag, or exact commit. */
export type GitRevisionSelection =
  | { readonly kind: 'branch'; readonly branch: string }
  | { readonly kind: 'tag'; readonly tag: string }
  | { readonly kind: 'commit'; readonly commit: GitCommitSha }

/** One selection resolved from the current fetched mirror state. */
export interface ResolvedGitRevision {
  readonly selection: GitRevisionSelection
  readonly commit: GitCommitSha
  readonly observedReference: string
  readonly observedObject: string
  readonly tagObject?: string
}

/** A previous mutable-reference observation used to detect a rewrite explicitly. */
export interface GitReferenceObservation {
  readonly selection: Exclude<GitRevisionSelection, { readonly kind: 'commit' }>
  readonly commit: GitCommitSha
  readonly observedObject: string
}

/** The generated, launcher-owned layout for one managed remote installation. */
export interface ManagedGitInstallationPaths {
  readonly installationId: string
  readonly namespacePath: string
  readonly installationPath: string
  readonly mirrorPath: string
  readonly worktreesPath: string
  readonly stagingPath: string
  readonly lockPath: string
}

/** Readback identity for a verified detached managed worktree. */
export interface ManagedGitWorktree {
  readonly path: string
  readonly commit: GitCommitSha
  readonly remote: GitNamedRemote
}

/** Read-only observation of a user-owned repository. */
export interface UnmanagedGitRepositoryInspection {
  readonly canonicalPath: string
  readonly head: GitCommitSha
  readonly remote: GitRemoteIdentity
  readonly dirtyEntries: readonly string[]
}
