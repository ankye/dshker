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
  pluginCatalogGetState: 'dsh-launcher:plugin-catalog:get-state',
  pluginCatalogRefresh: 'dsh-launcher:plugin-catalog:refresh'
} as const

/** Immutable product identity compiled into the launcher artifact. */
export const APP_METADATA = {
  appId: 'dsh-launcher',
  bundleId: 'com.ankye.dsh-launcher',
  name: 'DSH Launcher',
  version: '0.1.0'
} as const

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

/** Every typed error that may cross the first-release Launcher preload surface. */
export type DesktopApiErrorCode = BootstrapErrorCode | ManagedOperationErrorCode

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

/** One bounded stdout or stderr fragment emitted by the Launcher-started DSH Web process. */
export interface LauncherHarnessConsoleEntry {
  readonly stream: 'stdout' | 'stderr'
  readonly occurredAt: number
  readonly text: string
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
      readonly commits: readonly LauncherHarnessCommitView[]
      readonly stableVersions: readonly LauncherHarnessVersionView[]
      readonly plugins: readonly LauncherHarnessPluginView[]
      readonly console: readonly LauncherHarnessConsoleEntry[]
    }
  | {
      readonly kind: 'preparing' | 'missing' | 'invalid'
      readonly harnessDirectory: string
      readonly message: string
      readonly launch: LauncherHarnessLaunchView
      readonly commits: readonly []
      readonly stableVersions: readonly []
      readonly plugins: readonly []
      readonly console: readonly LauncherHarnessConsoleEntry[]
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
  }>
  readonly pluginCatalog: Readonly<{
    getState(): Promise<ApiResult<PluginCatalogState>>
    refresh(): Promise<ApiResult<PluginCatalogState>>
  }>
}

/** Creates an admitted native result. */
export function apiOk<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

/** Creates a sanitized native failure. */
export function apiFail<T, Code extends string>(code: Code, message: string): ApiResult<T, Code> {
  return { ok: false, code, message }
}
