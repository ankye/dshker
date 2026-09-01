import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  InstallLauncherHarnessPluginRequest,
  LauncherHarnessState,
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
  | 'uninstallPlugin'

// Module-level state: every shell surface observes the same Launcher-owned
// checkout, so the busy state one panel starts must also drive the statusbar.
const state = ref<LauncherHarnessState>()
const loading = ref(false)
const error = ref<string>()
const activeOperation = ref<LauncherHarnessOperation>()

const ready = computed(() => state.value?.kind === 'ready')
const canStart = computed(
  () => ready.value && state.value?.launch.kind !== 'running' && !loading.value
)

/** Refreshes state from the restricted Electron bridge only. */
async function refresh(): Promise<void> {
  if (!window.dshLauncher) {
    error.value = 'bridge'
    return
  }
  loading.value = true
  try {
    const result = await window.dshLauncher.launcherHarness.getState()
    if (!result.ok) {
      error.value = result.code
      return
    }
    state.value = result.data
    error.value = undefined
  } finally {
    loading.value = false
  }
}

/** Requests the fixed DSH Web command from Electron main. */
async function start(): Promise<void> {
  if (!window.dshLauncher || !canStart.value) return
  await applyOperation('start', () => window.dshLauncher!.launcherHarness.start())
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

/** Removes exactly one user-installed plugin through the standard DSH CLI forwarder. */
async function uninstallPlugin(request: UninstallLauncherHarnessPluginRequest): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  await applyOperation('uninstallPlugin', () =>
    window.dshLauncher!.launcherHarness.uninstallPlugin(request)
  )
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
        state.value?.kind === 'preparing' ||
        state.value?.launch.kind === 'running' ||
        state.value?.launch.kind === 'starting'
      ) {
        void refresh()
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
    uninstallPlugin
  }
}
