import { dialog, ipcMain, shell } from 'electron'
import {
  APP_METADATA,
  DESKTOP_API_VERSION,
  DESKTOP_IPC_CHANNELS,
  apiFail,
  apiOk,
  type ApiResult,
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
  type SwitchLauncherHarnessVersionRequest,
  type SwitchLauncherHarnessBranchRequest,
  type UninstallLauncherHarnessPluginRequest,
  type ManagedDirectorySelection,
  type ManagedExecutableKind,
  type ManagedExecutableSelection,
  type ManagedInstallationsState,
  type ManagedLauncherState,
  type RegisterManagedToolchainRequest,
  type RegisterManagedToolchainResult,
  type RegisterManagedRootsRequest,
  type SetLauncherHarnessPortRequest,
  type TokenUsageState,
  type StartManagedHarnessRequest,
  type StopManagedHarnessRequest,
  type SwitchManagedHarnessRevisionRequest
} from '../../src/shared/contracts'
import { assertDirectorySelectionPurpose } from './managed/capabilities'
import { ManagedRootError } from './managed/errors'
import { BundledSeedRuntimeError } from './managed/bundled-seed'
import { GitRuntimeError } from './managed/git'
import { type ManagedInstallationService } from './managed/installation-service'
import { type LauncherHarnessService } from './managed/launcher-harness-service'
import { type AwesomePluginCatalog } from './managed/awesome-plugin-catalog'
import { ManagedHarnessRuntimeError } from './managed/runtime-errors'
import { LAUNCHER_HARNESS_ERROR_CODES } from './managed/ipc-error-codes'
import { type ManagedWorkspaceService } from './managed/service'
import { SessionUsageReader } from './managed/session-usage-reader'
import { ToolchainRuntimeError } from './managed/toolchain'
import { isTrustedRenderer } from './security'

/** Dependencies for the restricted Electron IPC registration. */
export interface LauncherIpcOptions {
  readonly managedWorkspaceService: ManagedWorkspaceService
  readonly managedInstallationService: ManagedInstallationService
  readonly launcherHarnessService: LauncherHarnessService
  readonly sessionUsageReader: SessionUsageReader
  readonly pluginCatalog: AwesomePluginCatalog
}

/** Registers only named, sender-validated, runtime-validated Launcher IPC methods. */
export function registerIpc(options: LauncherIpcOptions): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.bootstrapInfo, (event, ...args): ApiResult<BootstrapInfo> => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidManagedPayload()
    return apiOk({
      apiVersion: DESKTOP_API_VERSION,
      appId: APP_METADATA.appId,
      name: APP_METADATA.name,
      version: APP_METADATA.version,
      platform: process.platform
    })
  })

  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedGetState,
    async (event, ...args): Promise<ApiResult<ManagedLauncherState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return managedResult(() => options.managedWorkspaceService.getState())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedSelectDirectory,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedDirectorySelection>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return managedResult(() =>
        options.managedWorkspaceService.selectDirectory(parseDirectorySelectionPurpose(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedRegisterRoots,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedLauncherState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return managedResult(() =>
        options.managedWorkspaceService.registerRoots(parseRegisterRootsRequest(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedCreateWorkspace,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedLauncherState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return managedResult(() =>
        options.managedWorkspaceService.createWorkspace(parseCreateWorkspaceRequest(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsGetState,
    async (event, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() => options.managedInstallationService.getState())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsSelectExecutable,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedExecutableSelection>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.selectExecutable(parseExecutablePurpose(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsRegisterToolchain,
    async (
      event,
      payload: unknown,
      ...args
    ): Promise<ApiResult<RegisterManagedToolchainResult>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.registerToolchain(
          parseRegisterManagedToolchainRequest(payload)
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsInstallBundledSeed,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.installBundledSeed(
          parseInstallBundledHarnessSeedRequest(payload)
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsCloneHarness,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.cloneHarness(parseCloneManagedHarnessRequest(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsSwitchRevision,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.switchRevision(
          parseSwitchManagedHarnessRevisionRequest(payload)
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsStartHarness,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.startHarness(parseStartManagedHarnessRequest(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.managedInstallationsStopHarness,
    async (event, payload: unknown, ...args): Promise<ApiResult<ManagedInstallationsState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return installationResult(() =>
        options.managedInstallationService.stopHarness(parseStopManagedHarnessRequest(payload))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessGetState,
    async (event, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() => options.launcherHarnessService.getState())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessStart,
    async (event, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() => options.launcherHarnessService.start())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessStop,
    async (event, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() => options.launcherHarnessService.stop())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessRefreshVersions,
    async (event, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() => options.launcherHarnessService.refreshVersions())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessUpdate,
    async (event, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() => options.launcherHarnessService.update())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessSwitchVersion,
    async (event, payload: unknown, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() =>
        options.launcherHarnessService.switchVersion(
          parseSwitchLauncherHarnessVersionRequest(payload).commit
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessSwitchBranch,
    async (event, payload: unknown, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() =>
        options.launcherHarnessService.switchBranch(
          parseSwitchLauncherHarnessBranchRequest(payload).branch
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.pluginCatalogGetState,
    async (event, ...args): Promise<ApiResult<PluginCatalogState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return pluginCatalogResult(() => options.pluginCatalog.getState())
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessInstallPlugin,
    async (event, payload: unknown, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() =>
        options.launcherHarnessService.installPlugin(
          parseInstallLauncherHarnessPluginRequest(payload).source
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessUninstallPlugin,
    async (event, payload: unknown, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() =>
        options.launcherHarnessService.uninstallPlugin(
          parseUninstallLauncherHarnessPluginRequest(payload).name
        )
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessRevealLog,
    async (event, ...args): Promise<ApiResult<LauncherHarnessLogFileView>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      // The service owns the path; the renderer cannot name a file to reveal.
      return launcherHarnessResult(() =>
        options.launcherHarnessService.revealLog((target) => shell.showItemInFolder(target))
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessExportLog,
    async (event, ...args): Promise<ApiResult<LauncherHarnessLogExportResult>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(async () => {
        // The destination comes from the user through a native dialog, never from
        // the renderer, so no renderer-controlled path is ever written to.
        const result = await dialog.showSaveDialog({
          title: 'Export launch log',
          defaultPath: `dsh-launcher-${new Date().toISOString().replace(/:/gu, '-')}.log`
        })
        if (result.canceled || result.filePath === undefined) {
          return { saved: false, path: undefined }
        }
        await options.launcherHarnessService.exportLog(result.filePath)
        return { saved: true, path: result.filePath }
      })
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherHarnessSetPort,
    async (event, payload: unknown, ...args): Promise<ApiResult<LauncherHarnessState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return launcherHarnessResult(() =>
        options.launcherHarnessService.setPort(parseSetLauncherHarnessPortRequest(payload).port)
      )
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.tokenUsageGetState,
    async (event, ...args): Promise<ApiResult<TokenUsageState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length > 1) return invalidManagedPayload()
      const [request] = args
      // The renderer is untrusted: only an integer row count is forwarded, and
      // the reader clamps it to its own ceiling.
      let limit: number | undefined
      if (request !== undefined) {
        if (typeof request !== 'object' || request === null) return invalidManagedPayload()
        const value = (request as { limit?: unknown }).limit
        if (value !== undefined) {
          if (!Number.isSafeInteger(value) || (value as number) <= 0) {
            return invalidManagedPayload()
          }
          limit = value as number
        }
      }
      try {
        return apiOk(await options.sessionUsageReader.read(limit === undefined ? {} : { limit }))
      } catch {
        return apiFail('managed.missing_registry', 'DSH session logs could not be read.')
      }
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.pluginCatalogRefresh,
    async (event, ...args): Promise<ApiResult<PluginCatalogState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidManagedPayload()
      return pluginCatalogResult(() => options.pluginCatalog.refresh())
    }
  )
}

function invalidSender<T>(): ApiResult<T> {
  return apiFail(
    'bootstrap.invalid_sender',
    'The request was not sent by the active launcher renderer.'
  )
}

function invalidManagedPayload<T>(): ApiResult<T> {
  return apiFail('managed.selection_invalid', 'The managed operation request is invalid.')
}

async function managedResult<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return apiOk(await operation())
  } catch (error) {
    if (error instanceof ManagedRootError) return apiFail(error.code, error.message)
    throw error
  }
}

async function installationResult<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return apiOk(await operation())
  } catch (error) {
    if (error instanceof ManagedRootError) return apiFail(error.code, error.message)
    if (error instanceof GitRuntimeError) {
      return apiFail('managed.git_operation_failed', 'Managed Git operation failed.')
    }
    if (error instanceof ToolchainRuntimeError) {
      return apiFail('managed.toolchain_invalid', 'Managed toolchain validation failed.')
    }
    if (error instanceof ManagedHarnessRuntimeError) {
      return apiFail(
        error.code === 'runtime.operation_in_progress'
          ? 'managed.harness_launch_in_progress'
          : 'managed.harness_launch_failed',
        'Managed Harness launch failed.'
      )
    }
    if (error instanceof BundledSeedRuntimeError) {
      return apiFail(
        error.code === 'bundled_seed.unavailable'
          ? 'managed.bundled_seed_unavailable'
          : 'managed.bundled_seed_invalid',
        'Bundled Harness seed is unavailable or invalid.'
      )
    }
    throw error
  }
}

/**
 * Maps one Harness runtime failure to the code the renderer explains; the
 * table itself lives in `./managed/ipc-error-codes` so a test holds it
 * accountable. Collapsing every cause into `harness_launch_failed` once made a
 * refused version switch — "stop DSH Web first" — read as "the core failed to
 * start".
 */
async function launcherHarnessResult<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return apiOk(await operation())
  } catch (error) {
    if (error instanceof ManagedHarnessRuntimeError) {
      return apiFail(
        LAUNCHER_HARNESS_ERROR_CODES[error.code] ?? 'managed.harness_launch_failed',
        error.message
      )
    }
    return apiFail('managed.harness_launch_failed', 'The Launcher Harness checkout is unavailable.')
  }
}

async function pluginCatalogResult<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return apiOk(await operation())
  } catch {
    return apiFail(
      'managed.git_operation_failed',
      'The curated plugin catalog could not be refreshed.'
    )
  }
}

function parseDirectorySelectionPurpose(payload: unknown): DirectorySelectionPurpose {
  const record = exactRecord(payload, ['purpose'])
  assertDirectorySelectionPurpose(record.purpose)
  return record.purpose
}

function parseRegisterRootsRequest(payload: unknown): RegisterManagedRootsRequest {
  const record = exactRecord(payload, ['selections'])
  if (!Array.isArray(record.selections) || record.selections.length !== 4) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Exactly four root selections are required.'
    )
  }
  const selections = record.selections.map((selection) => {
    const selectionRecord = exactRecord(selection, ['kind', 'capabilityId'])
    if (
      !isManagedRootKind(selectionRecord.kind) ||
      typeof selectionRecord.capabilityId !== 'string'
    ) {
      throw new ManagedRootError('managed.selection_invalid', 'Root selection is invalid.')
    }
    return { kind: selectionRecord.kind, capabilityId: selectionRecord.capabilityId }
  })
  return { selections }
}

function parseCreateWorkspaceRequest(payload: unknown): CreateManagedWorkspaceRequest {
  const record = exactRecord(payload, ['displayName', 'workingDirectoryCapabilityId'])
  if (
    typeof record.displayName !== 'string' ||
    typeof record.workingDirectoryCapabilityId !== 'string'
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Workspace registration request is invalid.'
    )
  }
  return {
    displayName: record.displayName,
    workingDirectoryCapabilityId: record.workingDirectoryCapabilityId
  }
}

function parseExecutablePurpose(payload: unknown): ManagedExecutableKind {
  const record = exactRecord(payload, ['purpose'])
  if (record.purpose !== 'git' && record.purpose !== 'node' && record.purpose !== 'pnpm') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Executable selection purpose is invalid.'
    )
  }
  return record.purpose
}

function parseRegisterManagedToolchainRequest(payload: unknown): RegisterManagedToolchainRequest {
  const record = exactRecord(payload, ['gitCapabilityId', 'nodeCapabilityId', 'pnpmCapabilityId'])
  if (
    typeof record.gitCapabilityId !== 'string' ||
    typeof record.nodeCapabilityId !== 'string' ||
    typeof record.pnpmCapabilityId !== 'string'
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Toolchain registration request is invalid.'
    )
  }
  return {
    gitCapabilityId: record.gitCapabilityId,
    nodeCapabilityId: record.nodeCapabilityId,
    pnpmCapabilityId: record.pnpmCapabilityId
  }
}

function parseInstallBundledHarnessSeedRequest(payload: unknown): InstallBundledHarnessSeedRequest {
  const record = exactRecord(payload, ['workspaceId', 'toolchainId'])
  if (typeof record.workspaceId !== 'string' || typeof record.toolchainId !== 'string') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Bundled seed installation request is invalid.'
    )
  }
  return { workspaceId: record.workspaceId, toolchainId: record.toolchainId }
}

function parseCloneManagedHarnessRequest(payload: unknown): CloneManagedHarnessRequest {
  const record = exactRecord(payload, ['workspaceId', 'toolchainId', 'remoteUrl', 'revision'])
  if (
    typeof record.workspaceId !== 'string' ||
    typeof record.toolchainId !== 'string' ||
    typeof record.remoteUrl !== 'string'
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Managed clone request is invalid.')
  }
  return {
    workspaceId: record.workspaceId,
    toolchainId: record.toolchainId,
    remoteUrl: record.remoteUrl,
    revision: parseRevisionRequest(record.revision)
  }
}

function parseSwitchManagedHarnessRevisionRequest(
  payload: unknown
): SwitchManagedHarnessRevisionRequest {
  const record = exactRecord(payload, ['workspaceId', 'installationId', 'revision'])
  if (typeof record.workspaceId !== 'string' || typeof record.installationId !== 'string') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Managed revision switch request is invalid.'
    )
  }
  return {
    workspaceId: record.workspaceId,
    installationId: record.installationId,
    revision: parseRevisionRequest(record.revision)
  }
}

function parseStartManagedHarnessRequest(payload: unknown): StartManagedHarnessRequest {
  const record = exactRecord(payload, ['workspaceId', 'installationId'])
  if (typeof record.workspaceId !== 'string' || typeof record.installationId !== 'string') {
    throw new ManagedRootError('managed.selection_invalid', 'Managed start request is invalid.')
  }
  return { workspaceId: record.workspaceId, installationId: record.installationId }
}

function parseStopManagedHarnessRequest(payload: unknown): StopManagedHarnessRequest {
  const record = exactRecord(payload, ['workspaceId', 'installationId'])
  if (typeof record.workspaceId !== 'string' || typeof record.installationId !== 'string') {
    throw new ManagedRootError('managed.selection_invalid', 'Managed stop request is invalid.')
  }
  return { workspaceId: record.workspaceId, installationId: record.installationId }
}

function parseSwitchLauncherHarnessVersionRequest(
  payload: unknown
): SwitchLauncherHarnessVersionRequest {
  const record = exactRecord(payload, ['commit'])
  if (typeof record.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(record.commit)) {
    throw new ManagedRootError('managed.selection_invalid', 'Harness version selection is invalid.')
  }
  return { commit: record.commit }
}

function parseSwitchLauncherHarnessBranchRequest(
  payload: unknown
): SwitchLauncherHarnessBranchRequest {
  const record = exactRecord(payload, ['branch'])
  if (
    typeof record.branch !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(record.branch)
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Harness branch selection is invalid.')
  }
  return { branch: record.branch }
}

function parseInstallLauncherHarnessPluginRequest(
  payload: unknown
): InstallLauncherHarnessPluginRequest {
  const record = exactRecord(payload, ['source'])
  if (
    typeof record.source !== 'string' ||
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/u.test(record.source)
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Plugin source selection is invalid.')
  }
  return { source: record.source }
}

function parseUninstallLauncherHarnessPluginRequest(
  payload: unknown
): UninstallLauncherHarnessPluginRequest {
  const record = exactRecord(payload, ['name'])
  if (typeof record.name !== 'string' || !/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(record.name)) {
    throw new ManagedRootError('managed.selection_invalid', 'Plugin name selection is invalid.')
  }
  return { name: record.name }
}

/** Admits only the two port shapes; the range itself is enforced by the service. */
function parseSetLauncherHarnessPortRequest(payload: unknown): SetLauncherHarnessPortRequest {
  const record = exactRecord(payload, ['port'])
  const port = record.port
  if (typeof port !== 'object' || port === null) {
    throw new ManagedRootError('managed.selection_invalid', 'Port selection is invalid.')
  }
  const candidate = port as Record<string, unknown>
  if (candidate.mode === 'auto') {
    exactRecord(candidate, ['mode'])
    return { port: { mode: 'auto' } }
  }
  if (candidate.mode !== 'fixed') {
    throw new ManagedRootError('managed.selection_invalid', 'Port mode selection is invalid.')
  }
  exactRecord(candidate, ['mode', 'port'])
  if (typeof candidate.port !== 'number') {
    throw new ManagedRootError('managed.selection_invalid', 'Port selection must be a number.')
  }
  return { port: { mode: 'fixed', port: candidate.port } }
}

function parseRevisionRequest(payload: unknown): CloneManagedHarnessRequest['revision'] {
  const record = exactRecord(payload, ['kind', 'value'])
  if (
    (record.kind !== 'branch' && record.kind !== 'tag' && record.kind !== 'commit') ||
    typeof record.value !== 'string'
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Managed revision request is invalid.')
  }
  return { kind: record.kind, value: record.value }
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Managed operation request must be an object.'
    )
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Managed operation request fields are invalid.'
    )
  }
  return record
}

function isManagedRootKind(
  value: unknown
): value is RegisterManagedRootsRequest['selections'][number]['kind'] {
  return value === 'harness' || value === 'plugins' || value === 'presets' || value === 'settings'
}
