/**
 * The only renderer-to-main contract available before a managed Harness runtime
 * has completed its separate desktop bridge handshake.
 */
export const DESKTOP_API_VERSION = 1 as const

/** The complete named IPC surface admitted by the first-release preload bridge. */
export const DESKTOP_IPC_CHANNELS = {
  bootstrapInfo: 'dsh-launcher:bootstrap-info',
  managedGetState: 'dsh-launcher:managed:get-state',
  managedSelectDirectory: 'dsh-launcher:managed:select-directory',
  managedRegisterRoots: 'dsh-launcher:managed:register-roots',
  managedCreateWorkspace: 'dsh-launcher:managed:create-workspace',
  managedInstallationsGetState: 'dsh-launcher:managed-installations:get-state',
  managedInstallationsSelectExecutable: 'dsh-launcher:managed-installations:select-executable',
  managedInstallationsRegisterToolchain: 'dsh-launcher:managed-installations:register-toolchain',
  managedInstallationsInstallBundledSeed: 'dsh-launcher:managed-installations:install-bundled-seed',
  managedInstallationsCloneHarness: 'dsh-launcher:managed-installations:clone-harness',
  managedInstallationsSwitchRevision: 'dsh-launcher:managed-installations:switch-revision',
  managedInstallationsStartHarness: 'dsh-launcher:managed-installations:start-harness',
  managedInstallationsStopHarness: 'dsh-launcher:managed-installations:stop-harness',
  launcherHarnessGetState: 'dsh-launcher:launcher-harness:get-state',
  launcherHarnessStart: 'dsh-launcher:launcher-harness:start',
  launcherHarnessStop: 'dsh-launcher:launcher-harness:stop',
  launcherHarnessRefreshVersions: 'dsh-launcher:launcher-harness:refresh-versions',
  launcherHarnessUpdate: 'dsh-launcher:launcher-harness:update',
  launcherHarnessSwitchVersion: 'dsh-launcher:launcher-harness:switch-version',
  launcherHarnessSwitchBranch: 'dsh-launcher:launcher-harness:switch-branch',
  launcherHarnessInstallPlugin: 'dsh-launcher:launcher-harness:install-plugin',
  launcherHarnessUninstallPlugin: 'dsh-launcher:launcher-harness:uninstall-plugin',
  launcherHarnessSetPort: 'dsh-launcher:launcher-harness:set-port',
  launcherHarnessRevealLog: 'dsh-launcher:launcher-harness:reveal-log',
  launcherHarnessExportLog: 'dsh-launcher:launcher-harness:export-log',
  tokenUsageGetState: 'dsh-launcher:token-usage:get-state',
  pluginCatalogGetState: 'dsh-launcher:plugin-catalog:get-state',
  pluginCatalogRefresh: 'dsh-launcher:plugin-catalog:refresh',
  externalLinkOpen: 'dsh-launcher:external-link:open'
} as const

/** Immutable product identity compiled into the launcher artifact. */
export const APP_METADATA = {
  appId: 'dsh-launcher',
  bundleId: 'com.ankye.dsh-launcher',
  name: 'DSH Launcher',
  version: '0.1.5'
} as const

/** The only product-source pages the Renderer may ask the OS browser to open. */
export const LAUNCHER_EXTERNAL_LINK_IDS = ['launcher-repository', 'harness-repository'] as const

/** One fixed external product-source destination. Arbitrary URLs are not admitted. */
export type LauncherExternalLinkId = (typeof LAUNCHER_EXTERNAL_LINK_IDS)[number]

/** Stable bootstrap failures that are safe to show before workspace setup. */
export type BootstrapErrorCode =
  | 'bootstrap.bridge_unavailable'
  | 'bootstrap.invalid_sender'
  | 'bootstrap.invalid_response'
  | 'bootstrap.main_unavailable'

/** Stable managed-root failures admitted across the Electron preload boundary. */
export type ManagedOperationErrorCode =
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
  /** A version or plugin operation was refused because DSH Web is still running. */
  | 'managed.harness_busy_running'
  /** The Launcher-owned checkout cannot serve the requested operation. */
  | 'managed.harness_worktree_invalid'
  /** The renderer supplied a selection the service rejected. */
  | 'managed.harness_input_invalid'
  /** The DSH CLI refused the plugin install or uninstall. */
  | 'managed.harness_plugin_operation_failed'

/** Failures from the fixed external product-source link capability. */
export type ExternalLinkErrorCode =
  | 'launcher.external_link_invalid'
  | 'launcher.external_link_open_failed'

/** Every typed error that may cross the first-release Launcher preload surface. */
export type DesktopApiErrorCode =
  | BootstrapErrorCode
  | ManagedOperationErrorCode
  | ExternalLinkErrorCode

/** A typed cross-process result without ambient exception serialization. */
export type ApiResult<T, Code extends string = DesktopApiErrorCode> =
  | {
      readonly ok: true
      readonly data: T
    }
  | {
      readonly ok: false
      readonly code: Code
      readonly message: string
    }

/** Exact information supplied by the active Electron main process. */
export interface BootstrapInfo {
  readonly apiVersion: typeof DESKTOP_API_VERSION
  readonly appId: typeof APP_METADATA.appId
  readonly name: typeof APP_METADATA.name
  readonly version: typeof APP_METADATA.version
  readonly platform: NodeJS.Platform
}

/** One independently selected application-level root role. */
export type ManagedRootKind = 'harness' | 'plugins' | 'presets' | 'settings'

/** Native picker purposes admitted from the renderer. */
export type DirectorySelectionPurpose =
  | `managed-root:${ManagedRootKind}`
  | 'workspace-working-directory'

/** An opaque capability returned after one native directory selection. */
export interface ManagedDirectorySelection {
  readonly capabilityId: string
  readonly purpose: DirectorySelectionPurpose
  readonly displayName: string
}

/** Renderer-safe view of one registered root. */
export interface ManagedRootView {
  readonly rootId: string
  readonly kind: ManagedRootKind
  readonly canonicalPath: string
}

/** Renderer-safe view of one registered workspace. */
export interface ManagedWorkspaceView {
  readonly workspaceId: string
  readonly displayName: string
  readonly workingDirectoryCanonicalPath: string
  readonly rootNamespaces: readonly {
    readonly rootId: string
    readonly namespace: string
  }[]
}

/** Launcher registry health exposed to the renderer without recovery fallbacks. */
export type ManagedLauncherState =
  | { readonly kind: 'setup-required'; readonly code: 'managed.missing_bootstrap_locator' }
  | {
      readonly kind: 'recovery-required'
      readonly code: Exclude<ManagedOperationErrorCode, 'managed.missing_bootstrap_locator'>
    }
  | {
      readonly kind: 'ready'
      readonly roots: readonly ManagedRootView[]
      readonly workspaces: readonly ManagedWorkspaceView[]
    }

/** Exact root-selection request; native directory paths never cross this interface. */
export interface RegisterManagedRootsRequest {
  readonly selections: readonly {
    readonly kind: ManagedRootKind
    readonly capabilityId: string
  }[]
}

/** Exact workspace-registration request with an opaque working-directory capability. */
export interface CreateManagedWorkspaceRequest {
  readonly displayName: string
  readonly workingDirectoryCapabilityId: string
}

/** The explicit external command roles needed to materialize and run a managed Harness checkout. */
export type ManagedExecutableKind = 'git' | 'node' | 'pnpm'

/** One exact branch, tag, or full commit selected by the user. */
export type ManagedRevisionRequest =
  | { readonly kind: 'branch'; readonly value: string }
  | { readonly kind: 'tag'; readonly value: string }
  | { readonly kind: 'commit'; readonly value: string }

/** One short-lived native executable-selection authority with no exposed filesystem path. */
export interface ManagedExecutableSelection {
  readonly capabilityId: string
  readonly purpose: ManagedExecutableKind
  readonly displayName: string
}

/** Renderer-safe identity for a fully validated explicit Git, Node, and pnpm toolchain. */
export interface ManagedToolchainView {
  readonly toolchainId: string
  readonly gitVersion: string
  readonly nodeVersion: string
  readonly pnpmVersion: string
}

/** Runtime state for the one child process associated with a managed installation. */
export interface ManagedHarnessLaunchView {
  readonly kind: 'stopped' | 'starting' | 'running' | 'failed'
  readonly launchId?: string
}

/** One exact managed Harness version materialized under a workspace Harness root. */
export interface ManagedHarnessInstallationView {
  readonly installationId: string
  readonly workspaceId: string
  readonly toolchainId: string
  readonly remoteUrl: string
  readonly requestedRevision: ManagedRevisionRequest
  readonly resolvedCommit: string
  readonly launch: ManagedHarnessLaunchView
}

/** Complete main-process projection of persisted toolchains and managed Harness installations. */
export interface ManagedInstallationsState {
  readonly toolchains: readonly ManagedToolchainView[]
  readonly installations: readonly ManagedHarnessInstallationView[]
}

/** One commit directly available in the Launcher-owned Harness checkout. */
export interface LauncherHarnessCommitView {
  readonly hash: string
  readonly subject: string
  readonly committedAt: number
}

/** A release tag paired with the exact commit it resolves to. */
export interface LauncherHarnessVersionView extends LauncherHarnessCommitView {
  readonly tag: string
}

/** One plugin layer observed in DSH's native `web` profile. */
export interface LauncherHarnessPluginView {
  readonly name: string
  readonly version: string
  /** `default` marks in-box template bundles; `user` marks installed dependencies. */
  readonly origin: 'default' | 'user'
  /**
   * Git remote backing this plugin, when one can be resolved.
   *
   * A plugin installed from a local `file:` path carries no source in the
   * profile manifest, so the remote is read from the checkout it points at.
   */
  readonly sourceUrl?: string
  /** Local checkout a `file:` dependency resolves to. */
  readonly localPath?: string
}

/** Whether a catalog entry is already installed, matched by git source. */
export interface PluginCatalogInstallState {
  readonly installedNames: readonly string[]
}

/** One curated plugin parsed from awesome-dsh-plugin's YAML source record. */
export interface PluginCatalogEntry {
  readonly id: string
  readonly url: string
  readonly name: string
  readonly category: string
  readonly description: string
}

/** Last known state of the Launcher-owned awesome-dsh-plugin source checkout. */
export type PluginCatalogState =
  | {
      readonly kind: 'empty'
      readonly remoteUrl: string
      readonly entries: readonly []
    }
  | {
      readonly kind: 'ready'
      readonly remoteUrl: string
      readonly revision: string
      readonly entries: readonly PluginCatalogEntry[]
    }

/** One bounded lifecycle event, command echo, or child-output fragment for the Launcher-started DSH Web process. */
export interface LauncherHarnessConsoleEntry {
  readonly stream: 'launcher' | 'command' | 'stdout' | 'stderr'
  readonly occurredAt: number
  readonly text: string
}

/**
 * Where the Launcher writes the started process's output.
 *
 * The in-memory console is capped, so a startup failure that scrolls past the
 * cap is only recoverable from the file. The path is always reported, even
 * before the first launch creates it, so the user can copy it while diagnosing.
 */
export interface LauncherHarnessLogFileView {
  readonly path: string
  /** False until the first launch writes output, so the UI can say so plainly. */
  readonly exists: boolean
  readonly byteLength: number
}

/**
 * Exact launch state for the direct Launcher-owned Harness checkout.
 *
 * `running` carries the URL the child itself announced. The Launcher never
 * predicts a port or synthesizes a loopback address, because `dsh web` chooses
 * its own port and may embed a session credential in the announced URL.
 */
export type LauncherHarnessLaunchView =
  | { readonly kind: 'stopped' | 'starting' }
  | { readonly kind: 'running'; readonly url: string }
  | { readonly kind: 'failed'; readonly message: string }

/** Main-process view of the bundled checkout and DSH's read-only native web profile. */
export type LauncherHarnessState =
  | {
      readonly kind: 'ready'
      readonly harnessDirectory: string
      readonly remoteUrl: string
      readonly currentBranch: string
      readonly branches: readonly string[]
      readonly revision: string | undefined
      readonly launch: LauncherHarnessLaunchView
      readonly port: LauncherHarnessPortSetting
      readonly commits: readonly LauncherHarnessCommitView[]
      readonly stableVersions: readonly LauncherHarnessVersionView[]
      readonly plugins: readonly LauncherHarnessPluginView[]
      readonly console: readonly LauncherHarnessConsoleEntry[]
      readonly logFile: LauncherHarnessLogFileView
    }
  | {
      readonly kind: 'preparing' | 'missing' | 'invalid'
      readonly harnessDirectory: string
      readonly message: string
      readonly launch: LauncherHarnessLaunchView
      readonly port: LauncherHarnessPortSetting
      readonly commits: readonly []
      readonly stableVersions: readonly []
      readonly plugins: readonly []
      readonly console: readonly LauncherHarnessConsoleEntry[]
      readonly logFile: LauncherHarnessLogFileView
    }

/** Outcome of exporting the log; a cancelled dialog is a success that wrote nothing. */
export interface LauncherHarnessLogExportResult {
  readonly saved: boolean
  readonly path: string | undefined
}

/** Capability-only request that registers the exact three executable identities. */
export interface RegisterManagedToolchainRequest {
  readonly gitCapabilityId: string
  readonly nodeCapabilityId: string
  readonly pnpmCapabilityId: string
}

/** Exact result of registering a persisted toolchain. */
export interface RegisterManagedToolchainResult {
  readonly toolchainId: string
  readonly state: ManagedInstallationsState
}

/** Clone request with no renderer-controlled filesystem path or process arguments. */
export interface CloneManagedHarnessRequest {
  readonly workspaceId: string
  readonly toolchainId: string
  readonly remoteUrl: string
  readonly revision: ManagedRevisionRequest
}

/** Installs the packaged DSH seed into the same ordinary managed workspace used by external clones. */
export interface InstallBundledHarnessSeedRequest {
  readonly workspaceId: string
  readonly toolchainId: string
}

/** Switch request for one registered installation only. */
export interface SwitchManagedHarnessRevisionRequest {
  readonly workspaceId: string
  readonly installationId: string
  readonly revision: ManagedRevisionRequest
}

/** Start request for one registered installation only. */
export interface StartManagedHarnessRequest {
  readonly workspaceId: string
  readonly installationId: string
}

/** Stop request for the one actively supervised Harness process in a registered workspace. */
export interface StopManagedHarnessRequest {
  readonly workspaceId: string
  readonly installationId: string
}

/** A version selection admitted only as a complete Git commit SHA. */
export interface SwitchLauncherHarnessVersionRequest {
  readonly commit: string
}

/** A branch selection admitted only by the fetched origin branch list. */
export interface SwitchLauncherHarnessBranchRequest {
  readonly branch: string
}

/** A plugin install source admitted only as an HTTPS GitHub repository URL. */
export interface InstallLauncherHarnessPluginRequest {
  readonly source: string
}

/**
 * The DSH web listen port the next launch will request.
 *
 * `mode: 'auto'` omits `--port` entirely and preserves the established
 * behaviour of letting DSH choose. `mode: 'fixed'` passes `--port <port>`.
 * The Launcher still reads the announced URL rather than assuming the
 * requested port was actually bound.
 */
export type LauncherHarnessPortSetting =
  | { readonly mode: 'auto' }
  | { readonly mode: 'fixed'; readonly port: number }

/** Lowest port accepted for a fixed selection; below this range binding needs privileges. */
export const LAUNCHER_HARNESS_MIN_PORT = 1024 as const

/** Highest valid TCP port. */
export const LAUNCHER_HARNESS_MAX_PORT = 65_535 as const

/** A port selection request originating in the renderer. */
export interface SetLauncherHarnessPortRequest {
  readonly port: LauncherHarnessPortSetting
}

/** A plugin uninstall selection admitted only by its installed package name. */
export interface UninstallLauncherHarnessPluginRequest {
  readonly name: string
}

/** Narrow preload capability; it deliberately has no file, process, or settings methods. */
export interface DesktopApi {
  readonly apiVersion: typeof DESKTOP_API_VERSION
  readonly bootstrap: Readonly<{
    getInfo(): Promise<ApiResult<BootstrapInfo, BootstrapErrorCode>>
  }>
  readonly managed: Readonly<{
    getState(): Promise<ApiResult<ManagedLauncherState>>
    selectDirectory(
      purpose: DirectorySelectionPurpose
    ): Promise<ApiResult<ManagedDirectorySelection>>
    registerRoots(request: RegisterManagedRootsRequest): Promise<ApiResult<ManagedLauncherState>>
    createWorkspace(
      request: CreateManagedWorkspaceRequest
    ): Promise<ApiResult<ManagedLauncherState>>
  }>
  readonly managedInstallations: Readonly<{
    getState(): Promise<ApiResult<ManagedInstallationsState>>
    selectExecutable(purpose: ManagedExecutableKind): Promise<ApiResult<ManagedExecutableSelection>>
    registerToolchain(
      request: RegisterManagedToolchainRequest
    ): Promise<ApiResult<RegisterManagedToolchainResult>>
    installBundledSeed(
      request: InstallBundledHarnessSeedRequest
    ): Promise<ApiResult<ManagedInstallationsState>>
    cloneHarness(request: CloneManagedHarnessRequest): Promise<ApiResult<ManagedInstallationsState>>
    switchRevision(
      request: SwitchManagedHarnessRevisionRequest
    ): Promise<ApiResult<ManagedInstallationsState>>
    startHarness(request: StartManagedHarnessRequest): Promise<ApiResult<ManagedInstallationsState>>
    stopHarness(request: StopManagedHarnessRequest): Promise<ApiResult<ManagedInstallationsState>>
  }>
  readonly launcherHarness: Readonly<{
    getState(): Promise<ApiResult<LauncherHarnessState>>
    start(): Promise<ApiResult<LauncherHarnessState>>
    stop(): Promise<ApiResult<LauncherHarnessState>>
    refreshVersions(): Promise<ApiResult<LauncherHarnessState>>
    update(): Promise<ApiResult<LauncherHarnessState>>
    switchVersion(
      request: SwitchLauncherHarnessVersionRequest
    ): Promise<ApiResult<LauncherHarnessState>>
    switchBranch(
      request: SwitchLauncherHarnessBranchRequest
    ): Promise<ApiResult<LauncherHarnessState>>
    installPlugin(
      request: InstallLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>>
    uninstallPlugin(
      request: UninstallLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>>
    setPort(request: SetLauncherHarnessPortRequest): Promise<ApiResult<LauncherHarnessState>>
    /** Shows the log file in the OS file manager; no renderer-supplied path. */
    revealLog(): Promise<ApiResult<LauncherHarnessLogFileView>>
    /** Copies the log to a user-chosen destination via a native save dialog. */
    exportLog(): Promise<ApiResult<LauncherHarnessLogExportResult>>
  }>
  readonly tokenUsage: Readonly<{
    getState(request?: TokenUsageRequest): Promise<ApiResult<TokenUsageState>>
  }>
  readonly pluginCatalog: Readonly<{
    getState(): Promise<ApiResult<PluginCatalogState>>
    refresh(): Promise<ApiResult<PluginCatalogState>>
  }>
  readonly externalLinks: Readonly<{
    /** Opens one product-controlled source URL in the operating-system browser. */
    open(linkId: LauncherExternalLinkId): Promise<ApiResult<void, ExternalLinkErrorCode>>
  }>
}

/** Token usage of one DSH session, as recorded by DSH's own token meter. */
export interface SessionTokenUsage {
  readonly sessionId: string
  /** Project root the session ran in, restored from DSH's flattened directory name. */
  readonly project: string
  readonly createdAt: number
  /** Log mtime, used as the session's last-activity time. */
  readonly updatedAt: number
  readonly sizeBytes: number
  readonly turns: number
  readonly steps: number
  readonly model?: string
  readonly provider?: string
  /** First user prompt, truncated, so a session is recognizable in a list. */
  readonly firstPrompt?: string
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Summed billing buckets across every readable session. */
export interface TokenUsageTotals {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** How many detailed session rows the renderer wants; totals always cover all. */
export interface TokenUsageRequest {
  readonly limit?: number
}

/** Read-only view of DSH's recorded token usage. */
export interface TokenUsageState {
  readonly kind: 'ready'
  /** The newest sessions in detail, bounded by the requested limit. */
  readonly sessions: readonly SessionTokenUsage[]
  /** Every readable session, so the page can say what the detail list omits. */
  readonly totalSessions: number
  /** Summed over every readable session, never only the returned page. */
  readonly totals: TokenUsageTotals
  /** Sessions whose log could not be read, reported instead of silently dropped. */
  readonly unreadableSessions: number
}

/** Creates an admitted native result. */
export function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

/** Creates a sanitized native failure. */
export function apiFail<T, Code extends string>(code: Code, message: string): ApiResult<T, Code> {
  return { ok: false, code, message }
}
