import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC_CHANNELS,
  type ApiResult,
  type BootstrapErrorCode,
  type BootstrapInfo,
  type CloneManagedHarnessRequest,
  type CreateManagedWorkspaceRequest,
  type DirectorySelectionPurpose,
  type InstallBundledHarnessSeedRequest,
  type InstallLauncherHarnessPluginRequest,
  type AdoptLauncherHarnessPluginRequest,
  type UpdateLauncherHarnessPluginRequest,
  type LauncherHarnessConsoleEntry,
  type LauncherHarnessLogExportResult,
  type LauncherHarnessLogFileView,
  type LauncherHarnessState,
  type LauncherUpdateState,
  type PluginCatalogState,
  type ManagedDirectorySelection,
  type ManagedExecutableKind,
  type ManagedExecutableSelection,
  type ManagedInstallationsState,
  type ManagedLauncherState,
  type RegisterManagedToolchainRequest,
  type RegisterManagedToolchainResult,
  type RegisterManagedRootsRequest,
  type RuntimeBrowserHostRenderingInfo,
  type RuntimeBrowserPreferences,
  type SetRuntimeBrowserZoomRequest,
  type SetLauncherHarnessPortRequest,
  type TokenUsageRequest,
  type TokenUsageState,
  type StartManagedHarnessRequest,
  type StopManagedHarnessRequest,
  type SwitchManagedHarnessRevisionRequest,
  type SwitchLauncherHarnessVersionRequest,
  type SwitchLauncherHarnessBranchRequest,
  type UninstallLauncherHarnessPluginRequest,
  type DesktopApi,
  type ExternalLinkErrorCode,
  type LauncherExternalLinkId
} from '../src/shared/contracts'

const desktopApi: DesktopApi = Object.freeze({
  apiVersion: DESKTOP_API_VERSION,
  bootstrap: Object.freeze({
    getInfo: (): Promise<ApiResult<BootstrapInfo, BootstrapErrorCode>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.bootstrapInfo)
  }),
  managed: Object.freeze({
    getState: (): Promise<ApiResult<ManagedLauncherState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedGetState),
    selectDirectory: (
      purpose: DirectorySelectionPurpose
    ): Promise<ApiResult<ManagedDirectorySelection>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedSelectDirectory, { purpose }),
    registerRoots: (
      request: RegisterManagedRootsRequest
    ): Promise<ApiResult<ManagedLauncherState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedRegisterRoots, request),
    createWorkspace: (
      request: CreateManagedWorkspaceRequest
    ): Promise<ApiResult<ManagedLauncherState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedCreateWorkspace, request)
  }),
  managedInstallations: Object.freeze({
    getState: (): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsGetState),
    selectExecutable: (
      purpose: ManagedExecutableKind
    ): Promise<ApiResult<ManagedExecutableSelection>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsSelectExecutable, { purpose }),
    registerToolchain: (
      request: RegisterManagedToolchainRequest
    ): Promise<ApiResult<RegisterManagedToolchainResult>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsRegisterToolchain, request),
    installBundledSeed: (
      request: InstallBundledHarnessSeedRequest
    ): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsInstallBundledSeed, request),
    cloneHarness: (
      request: CloneManagedHarnessRequest
    ): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsCloneHarness, request),
    switchRevision: (
      request: SwitchManagedHarnessRevisionRequest
    ): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsSwitchRevision, request),
    startHarness: (
      request: StartManagedHarnessRequest
    ): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsStartHarness, request),
    stopHarness: (
      request: StopManagedHarnessRequest
    ): Promise<ApiResult<ManagedInstallationsState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.managedInstallationsStopHarness, request)
  }),
  launcherHarness: Object.freeze({
    getState: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessGetState),
    // The only push channel on the frozen bridge: main appends console entries,
    // the renderer receives exactly what it appended and can stop listening.
    onConsoleAppend: (
      listener: (entries: readonly LauncherHarnessConsoleEntry[]) => void
    ): (() => void) => {
      const onAppended = (
        _event: unknown,
        entries: readonly LauncherHarnessConsoleEntry[]
      ): void => {
        listener(entries)
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.launcherHarnessConsoleAppended, onAppended)
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.launcherHarnessConsoleAppended, onAppended)
      }
    },
    start: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessStart),
    stop: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessStop),
    refreshVersions: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessRefreshVersions),
    update: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessUpdate),
    switchVersion: (
      request: SwitchLauncherHarnessVersionRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessSwitchVersion, request),
    switchBranch: (
      request: SwitchLauncherHarnessBranchRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessSwitchBranch, request),
    installPlugin: (
      request: InstallLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessInstallPlugin, request),
    installPluginArchive: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessInstallPluginArchive),
    refreshPlugins: (): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessRefreshPlugins),
    updatePlugin: (
      request: UpdateLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessUpdatePlugin, request),
    adoptPlugin: (
      request: AdoptLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessAdoptPlugin, request),
    uninstallPlugin: (
      request: UninstallLauncherHarnessPluginRequest
    ): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessUninstallPlugin, request),
    setPort: (request: SetLauncherHarnessPortRequest): Promise<ApiResult<LauncherHarnessState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessSetPort, request),
    revealLog: (): Promise<ApiResult<LauncherHarnessLogFileView>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessRevealLog),
    exportLog: (): Promise<ApiResult<LauncherHarnessLogExportResult>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherHarnessExportLog)
  }),
  tokenUsage: Object.freeze({
    getState: (request?: TokenUsageRequest): Promise<ApiResult<TokenUsageState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.tokenUsageGetState, request)
  }),
  runtimeBrowser: Object.freeze({
    getPreferences: (): Promise<ApiResult<RuntimeBrowserPreferences>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeBrowserGetPreferences),
    setZoom: (
      request: SetRuntimeBrowserZoomRequest
    ): Promise<ApiResult<RuntimeBrowserPreferences>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeBrowserSetZoom, request),
    getHostRenderingInfo: (): Promise<ApiResult<RuntimeBrowserHostRenderingInfo>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeBrowserGetHostRenderingInfo),
    onZoomChange: (
      listener: (result: ApiResult<RuntimeBrowserPreferences>) => void
    ): (() => void) => {
      const onChanged = (_event: unknown, result: ApiResult<RuntimeBrowserPreferences>): void => {
        listener(result)
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeBrowserZoomChanged, onChanged)
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeBrowserZoomChanged, onChanged)
      }
    }
  }),
  launcherUpdates: Object.freeze({
    getState: (): Promise<ApiResult<LauncherUpdateState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherUpdatesGetState),
    check: (): Promise<ApiResult<LauncherUpdateState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherUpdatesCheck),
    openInstallerDownload: (): Promise<ApiResult<LauncherUpdateState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.launcherUpdatesOpenInstallerDownload),
    onStateChange: (listener: (result: ApiResult<LauncherUpdateState>) => void): (() => void) => {
      const onChanged = (_event: unknown, result: ApiResult<LauncherUpdateState>): void => {
        listener(result)
      }
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.launcherUpdatesStateChanged, onChanged)
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.launcherUpdatesStateChanged, onChanged)
      }
    }
  }),
  pluginCatalog: Object.freeze({
    getState: (): Promise<ApiResult<PluginCatalogState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pluginCatalogGetState),
    refresh: (): Promise<ApiResult<PluginCatalogState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pluginCatalogRefresh)
  }),
  externalLinks: Object.freeze({
    open: (linkId: LauncherExternalLinkId): Promise<ApiResult<void, ExternalLinkErrorCode>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.externalLinkOpen, linkId)
  })
})

contextBridge.exposeInMainWorld('dshLauncher', desktopApi)
