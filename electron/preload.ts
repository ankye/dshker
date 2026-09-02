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
  type LauncherHarnessLogExportResult,
  type LauncherHarnessLogFileView,
  type LauncherHarnessState,
  type PluginCatalogState,
  type ManagedDirectorySelection,
  type ManagedExecutableKind,
  type ManagedExecutableSelection,
  type ManagedInstallationsState,
  type ManagedLauncherState,
  type RegisterManagedToolchainRequest,
  type RegisterManagedToolchainResult,
  type RegisterManagedRootsRequest,
  type SetLauncherHarnessPortRequest,
  type TokenUsageRequest,
  type TokenUsageState,
  type StartManagedHarnessRequest,
  type StopManagedHarnessRequest,
  type SwitchManagedHarnessRevisionRequest,
  type SwitchLauncherHarnessVersionRequest,
  type SwitchLauncherHarnessBranchRequest,
  type UninstallLauncherHarnessPluginRequest,
  type DesktopApi
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
  pluginCatalog: Object.freeze({
    getState: (): Promise<ApiResult<PluginCatalogState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pluginCatalogGetState),
    refresh: (): Promise<ApiResult<PluginCatalogState>> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.pluginCatalogRefresh)
  })
})

contextBridge.exposeInMainWorld('dshLauncher', desktopApi)
