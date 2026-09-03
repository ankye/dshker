import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  InstallLauncherHarnessPluginRequest,
  AdoptLauncherHarnessPluginRequest,
  UpdateLauncherHarnessPluginRequest,
  LauncherHarnessState,
  SetLauncherHarnessPortRequest,
  SwitchLauncherHarnessBranchRequest,
  SwitchLauncherHarnessVersionRequest,
  UninstallLauncherHarnessPluginRequest
} from '@/shared/contracts'

/** The long-running harness operation the shell should surface as progress. */
export type LauncherHarnessOperation =
  | 'switch'
  | 'update'
  | 'start'
  | 'stop'
  | 'refresh'
  | 'installPlugin'
  | 'installPluginArchive'
  | 'refreshPlugins'
  | 'updatePlugin'
  | 'adoptPlugin'
  | 'uninstallPlugin'
  | 'setPort'

// Module-level state: every shell surface observes the same Launcher-owned
// checkout, so the busy state one panel starts must also drive the statusbar.
// Module-level: every surface observes one Launcher-owned harness state.
export const harnessState = ref<LauncherHarnessState>()
const state = harnessState
const loading = ref(false)
const error = ref<string>()
const activeOperation = ref<LauncherHarnessOperation>()
let silentRefreshInFlight = false

/**
 * Counts launches the user actually initiated from this window.
 *
 * A counter rather than a boolean: the shell reacts to each new launch, so a
 * second attempt after a failure must be distinguishable from the first.
 */
export const launchAttempts = ref(0)

const ready = computed(() => state.value?.kind === 'ready')
// `starting` must disable the control too: the child is spawned but has not yet
// announced its URL, and a second activation would race the first.
const canStart = computed(
  () =>
    ready.value &&
    state.value?.launch.kind !== 'running' &&
    state.value?.launch.kind !== 'starting' &&
    !loading.value
)

/** Reads one authoritative Launcher state without publishing a user-operation busy state. */
async function readState(): Promise<void> {
  if (!window.dshLauncher) {
    error.value = 'bridge'
    return
  }
  const result = await window.dshLauncher.launcherHarness.getState()
  if (!result.ok) {
    error.value = result.code
    return
  }
  state.value = result.data
  error.value = undefined
}

/** Refreshes state from the restricted Electron bridge and marks initial/manual loading. */
async function refresh(): Promise<void> {
  loading.value = true
  try {
    await readState()
  } finally {
    loading.value = false
  }
}

/** Updates runtime output and child state without disabling unrelated page controls. */
async function refreshSilently(): Promise<void> {
  if (silentRefreshInFlight || loading.value) return
  silentRefreshInFlight = true
  try {
    await readState()
  } finally {
    silentRefreshInFlight = false
  }
}

/**
 * Requests the fixed DSH Web command from Electron main.
 *
 * Increments `launchAttempts` on success so the shell can follow the launch to
 * the console. A failed launch prints its reason to that console, and the user
 * previously had to know to go looking for it.
 */
async function start(): Promise<void> {
  if (!window.dshLauncher || !canStart.value) return
  await applyOperation('start', () => window.dshLauncher!.launcherHarness.start())
  launchAttempts.value += 1
}

/** Reveals the launch log in the OS file manager. */
async function revealLog(): Promise<boolean> {
  if (!window.dshLauncher) return false
  const result = await window.dshLauncher.launcherHarness.revealLog()
  if (!result.ok) error.value = result.code
  return result.ok
}

/** Exports the launch log through a native save dialog owned by the main process. */
async function exportLog(): Promise<boolean> {
  if (!window.dshLauncher) return false
  const result = await window.dshLauncher.launcherHarness.exportLog()
  if (!result.ok) {
    error.value = result.code
    return false
  }
  return result.data.saved
}

/** Stops only the DSH Web process created by the Launcher. */
async function stop(): Promise<void> {
  if (!window.dshLauncher || !ready.value || state.value?.launch.kind !== 'running') return
  await applyOperation('stop', () => window.dshLauncher!.launcherHarness.stop())
}

/** Fetches remote refs without changing the active checkout. */
async function refreshVersions(): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('refresh', () => window.dshLauncher!.launcherHarness.refreshVersions())
}

/** Fetches and switches to the newest remote master commit. */
async function update(): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('update', () => window.dshLauncher!.launcherHarness.update())
}

/** Switches only to the selected complete Git commit. */
async function switchVersion(request: SwitchLauncherHarnessVersionRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('switch', () => window.dshLauncher!.launcherHarness.switchVersion(request))
}

/** Fetches and switches to an origin branch selected from the current list. */
async function switchBranch(request: SwitchLauncherHarnessBranchRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('switch', () => window.dshLauncher!.launcherHarness.switchBranch(request))
}

/** Installs one curated plugin source through the standard DSH CLI forwarder. */
export async function installPlugin(request: InstallLauncherHarnessPluginRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('installPlugin', () =>
    window.dshLauncher!.launcherHarness.installPlugin(request)
  )
}

/** Opens the native ZIP picker and installs its package through the standard DSH CLI forwarder. */
export async function installPluginArchive(): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('installPluginArchive', () =>
    window.dshLauncher!.launcherHarness.installPluginArchive()
  )
}

/** Fetches managed plugin sources and refreshes their update availability. */
export async function refreshPlugins(): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('refreshPlugins', () => window.dshLauncher!.launcherHarness.refreshPlugins())
}

/** Refreshes one Launcher-managed Git plugin and reconciles it through the DSH CLI. */
export async function updatePlugin(request: UpdateLauncherHarnessPluginRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('updatePlugin', () =>
    window.dshLauncher!.launcherHarness.updatePlugin(request)
  )
}

/** Moves one legacy local Git plugin to a Launcher-owned source before updating it. */
export async function adoptPlugin(request: AdoptLauncherHarnessPluginRequest): Promise<void> {
  const launcherHarness = window.dshLauncher?.launcherHarness
  if (launcherHarness === undefined || typeof launcherHarness.adoptPlugin !== 'function') {
    error.value = 'bridge'
    return
  }
  if (loading.value) return
  await applyOperation('adoptPlugin', () => launcherHarness.adoptPlugin(request))
}

/** Removes exactly one user-installed plugin through the standard DSH CLI forwarder. */
export async function uninstallPlugin(
  request: UninstallLauncherHarnessPluginRequest
): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('uninstallPlugin', () =>
    window.dshLauncher!.launcherHarness.uninstallPlugin(request)
  )
}

/** Records the DSH web port the next launch will request. */
async function setPort(request: SetLauncherHarnessPortRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('setPort', () => window.dshLauncher!.launcherHarness.setPort(request))
}

async function applyOperation(
  operation: LauncherHarnessOperation,
  ipcOperation: () => ReturnType<
    NonNullable<typeof window.dshLauncher>['launcherHarness']['update']
  >
): Promise<void> {
  loading.value = true
  activeOperation.value = operation
  try {
    const result = await ipcOperation()
    if (!result.ok) {
      error.value = result.code
      return
    }
    state.value = result.data
    error.value = undefined
  } finally {
    loading.value = false
    activeOperation.value = undefined
  }
}

/** Renderer state for the one Launcher-owned Harness checkout. */
export function useLauncherHarness() {
  let polling: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    void refresh()
    polling = setInterval(() => {
      if (
        !loading.value &&
        (state.value?.kind === 'preparing' ||
          state.value?.launch.kind === 'running' ||
          state.value?.launch.kind === 'starting')
      ) {
        void refreshSilently()
      }
    }, 1_500)
  })
  onUnmounted(() => {
    if (polling !== undefined) clearInterval(polling)
  })
  return {
    state,
    loading,
    error,
    activeOperation,
    launchAttempts,
    revealLog,
    exportLog,
    ready,
    canStart,
    refresh,
    start,
    stop,
    refreshVersions,
    update,
    switchVersion,
    switchBranch,
    installPlugin,
    installPluginArchive,
    refreshPlugins,
    updatePlugin,
    adoptPlugin,
    uninstallPlugin,
    setPort
  }
}
