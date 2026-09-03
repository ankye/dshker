import { app, BrowserWindow, protocol } from 'electron'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './main/ipc'
import {
  DirectorySelectionCapabilities,
  ElectronDirectoryPicker,
  ElectronExecutablePicker,
  ExecutableSelectionCapabilities,
  BundledHarnessBootstrap,
  AwesomePluginCatalog,
  LauncherHarnessService,
  ManagedBootstrapLocatorStore,
  ManagedHarnessWebRuntimeSupervisor,
  ManagedInstallationService,
  ManagedWorkspaceService,
  type ManagedPathStyle
} from './main/managed'
import { SessionUsageReader } from './main/managed/session-usage-reader'
import { registerLauncherProtocol } from './main/protocol'
import { resolvePnpmLauncher } from './main/pnpm-launcher'
import { runSmokeTest, writeSmokeFailure } from './main/smoke'
import { createWindow } from './main/window'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'dsh-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
])

const mainDirectory = path.dirname(fileURLToPath(import.meta.url))
const DIRECTORY_SELECTION_TTL_MILLISECONDS = 5 * 60 * 1_000
const EXECUTABLE_SELECTION_TTL_MILLISECONDS = 5 * 60 * 1_000
const BUNDLED_HARNESS_REMOTE_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const IS_SMOKE_TEST =
  process.env.DESKTOP_APP_SMOKE_TEST === '1' || process.env.ELECTRON_SMOKE_TEST === '1'

const GIT_EXECUTABLE = resolveGitExecutable()
const PNPM_LAUNCHER = resolvePnpmLauncher()

/**
 * Resolves the system Git executable without a shell lookup.
 *
 * Windows ships no `/usr/bin/git`, so the launcher resolves the PATH-registered
 * `git` command instead of hard-coding a POSIX path. POSIX systems keep the
 * explicit `/usr/bin/git` identity the bundled seed contract already uses.
 */
function resolveGitExecutable(): string {
  return process.platform === 'win32' ? 'git' : '/usr/bin/git'
}

/**
 * Renders the packaged shell for release evidence and exits.
 *
 * Smoke mode registers the real IPC surface, because the shell reads its state
 * through those channels and cannot mount without them. It points every managed
 * root at a disposable directory and skips the bundled-Harness bootstrap, so
 * proving that the packaged renderer paints never touches the user's real
 * `~/.dshlauncher` roots or clones a Harness checkout.
 */
async function startSmokeTest(): Promise<void> {
  await app.whenReady()
  await registerLauncherProtocol(mainDirectory)
  const launcherRoot = path.join(app.getPath('temp'), 'dsh-launcher-smoke', String(process.pid))
  await registerLauncherServices(
    launcherRoot,
    path.join(launcherRoot, 'dsh-launcher-bootstrap.json')
  )
  await runSmokeTest(mainDirectory)
}

async function start(): Promise<void> {
  await app.whenReady()
  await registerLauncherProtocol(mainDirectory)
  const launcherHarnessService = await registerLauncherServices(
    path.join(homedir(), '.dshlauncher'),
    path.join(app.getPath('userData'), 'dsh-launcher-bootstrap.json')
  )
  registerHarnessShutdown(launcherHarnessService)
  createWindow(mainDirectory)
  initializeBundledHarnessInBackground(launcherHarnessService)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mainDirectory)
  })
}

/** Keeps the DSH process tree under Launcher ownership through normal quits and termination signals. */
function registerHarnessShutdown(service: LauncherHarnessService): void {
  let shutdownInProgress = false
  let shutdownComplete = false
  const shutdown = async () => {
    if (shutdownInProgress) return
    shutdownInProgress = true
    try {
      await service.shutdown()
      shutdownComplete = true
      app.quit()
    } catch (error) {
      shutdownInProgress = false
      console.error('DSHKer Launcher could not stop its managed DSH process tree.', error)
    }
  }
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    void shutdown()
  })
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

/**
 * Creates every managed service under one Launcher root and registers its IPC surface.
 *
 * The bootstrap locator path is separate from the root so smoke mode can redirect
 * both, while the product keeps its established `userData` registry location.
 */
async function registerLauncherServices(
  launcherRoot: string,
  locatorFilePath: string
): Promise<LauncherHarnessService> {
  const managedWorkspaceService = await createManagedWorkspaceService(launcherRoot, locatorFilePath)
  await managedWorkspaceService.initializeDefaultRoots()
  const launcherHarnessService = new LauncherHarnessService({
    harnessDirectory: path.join(launcherRoot, 'harness'),
    dshHomeDirectory: path.join(homedir(), '.dsh'),
    launchPreferencesPath: path.join(launcherRoot, 'launch-preferences.json'),
    launchLogPath: path.join(launcherRoot, 'logs', 'dsh-web.log'),
    diagnosticsPatchPath: app.isPackaged
      ? path.join(process.resourcesPath, 'dsh-launcher-verbose-logging.patch.yml')
      : path.join(app.getAppPath(), 'resources', 'dsh-launcher-verbose-logging.patch.yml'),
    gitExecutable: GIT_EXECUTABLE,
    pnpmExecutable: PNPM_LAUNCHER.executable,
    pnpmLauncher: PNPM_LAUNCHER
  })
  registerIpc({
    managedWorkspaceService,
    sessionUsageReader: new SessionUsageReader({
      dshHomeDirectory: path.join(homedir(), '.dsh'),
      cachePath: path.join(launcherRoot, 'session-usage-cache.json')
    }),
    pluginCatalog: new AwesomePluginCatalog({
      pluginsDirectory: path.join(launcherRoot, 'plugins'),
      gitExecutable: GIT_EXECUTABLE
    }),
    launcherHarnessService,
    managedInstallationService: new ManagedInstallationService({
      workspaceService: managedWorkspaceService,
      executableCapabilities: new ExecutableSelectionCapabilities({
        ttlMilliseconds: EXECUTABLE_SELECTION_TTL_MILLISECONDS
      }),
      executablePicker: new ElectronExecutablePicker(),
      temporaryDirectory: app.getPath('temp'),
      runtimeSupervisor: new ManagedHarnessWebRuntimeSupervisor()
    })
  })
  return launcherHarnessService
}

/** Creates the packaged initial checkout only when the Launcher-owned Harness root is empty. */
function initializeBundledHarnessInBackground(service: LauncherHarnessService): void {
  if (!app.isPackaged) return
  service.setBootstrapState('preparing')
  void new BundledHarnessBootstrap()
    .initialize({
      harnessDirectory: path.join(homedir(), '.dshlauncher', 'harness'),
      // One canonical staged layout: the Git bundle lives under `harness/`
      // beside the seed manifest and plugin generation.
      bundlePath: path.join(
        process.resourcesPath,
        'bundled-seed',
        'harness',
        'deepseek-harness.git.bundle'
      ),
      remoteUrl: BUNDLED_HARNESS_REMOTE_URL,
      gitExecutable: GIT_EXECUTABLE,
      pnpmExecutable: PNPM_LAUNCHER.executable,
      pnpmLauncher: PNPM_LAUNCHER
    })
    .then(() => service.setBootstrapState(undefined))
    .catch((error: unknown) => {
      service.setBootstrapState({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The bundled DSH could not be prepared.'
      })
    })
}

async function createManagedWorkspaceService(
  launcherRoot: string,
  locatorFilePath: string
): Promise<ManagedWorkspaceService> {
  const pathStyle: ManagedPathStyle = process.platform === 'win32' ? 'win32' : 'posix'
  const nativeDshHomePath = await resolveNativeDshHomePath()
  return new ManagedWorkspaceService({
    locator: new ManagedBootstrapLocatorStore({
      filePath: locatorFilePath,
      pathStyle,
      nativeDshHomePath
    }),
    capabilities: new DirectorySelectionCapabilities({
      ttlMilliseconds: DIRECTORY_SELECTION_TTL_MILLISECONDS
    }),
    directoryPicker: new ElectronDirectoryPicker(),
    pathStyle,
    nativeDshHomePath,
    defaultRootPaths: {
      harness: path.join(launcherRoot, 'harness'),
      plugins: path.join(launcherRoot, 'plugins'),
      presets: path.join(launcherRoot, 'presets'),
      settings: path.join(launcherRoot, 'settings')
    }
  })
}

/** Resolves the existing DSH home only to keep Launcher roots out of it; it never rewrites its value. */
async function resolveNativeDshHomePath(): Promise<string> {
  const configured = process.env.DSH_HOME
  const selected =
    configured !== undefined && configured.trim().length > 0
      ? expandHomePath(configured)
      : path.join(homedir(), '.dsh')
  const resolved = path.resolve(selected)
  try {
    return await realpath(resolved)
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return resolved
    throw error
  }
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}

if (IS_SMOKE_TEST) {
  void startSmokeTest()
    .then(() => {
      app.exit(0)
    })
    .catch(async (error: unknown) => {
      console.error('DSHKer Launcher smoke test failed.', error)
      await writeSmokeFailure(error)
      app.exit(1)
    })
} else {
  void start().catch((error: unknown) => {
    console.error('DSHKer Launcher could not start.', error)
    app.exit(1)
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
