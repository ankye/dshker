import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  InstallLauncherHarnessPluginRequest,
  AdoptLauncherHarnessPluginRequest,
  UpdateLauncherHarnessPluginRequest,
  LauncherHarnessConsoleEntry,
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
/**
 * Live console feed, unioned from state snapshots and push events.
 *
 * Append events and `getState` responses can overtake each other, so entries
 * are merged by sequence rather than replaced; the feed stays event-driven
 * instead of waiting for the next periodic state read.
 */
export const harnessConsole = ref<readonly LauncherHarnessConsoleEntry[]>([])
const consoleFeed = harnessConsole
const loading = ref(false)
const error = ref<string>()
const activeOperation = ref<LauncherHarnessOperation>()
/** Wall clock and feed position of the running operation, for step progress. */
let operationStartedAtMs = 0
let operationStartIndex = 0
let silentRefreshInFlight = false
let consoleSubscribed = false

/**
 * Live step progress for the running operation, or undefined while idle.
 *
 * Recomputed on every pushed console entry, so silent steps still refresh it
 * through their heartbeats and busy steps through their streamed output.
 */
const operationProgress = computed<LauncherOperationProgress | undefined>(() => {
  const operation = activeOperation.value
  if (operation === undefined || operationStartedAtMs === 0) return undefined
  const entries = consoleFeed.value.slice(operationStartIndex)
  return computeOperationStepProgress(operation, entries, operationStartedAtMs, Date.now())
})

/** Mirrors the in-memory console cap, so the feed never outgrows the service. */
const CONSOLE_FEED_LIMIT = 1_000

/**
 * Unions console entries by sequence, keeping the newest slice.
 *
 * A snapshot taken before an append event can arrive after it; replacing the
 * feed with that snapshot would drop the appended entries, and appending the
 * snapshot blindly would duplicate them. Union-by-`seq` is order-independent.
 */
export function mergeConsoleEntries(
  current: readonly LauncherHarnessConsoleEntry[],
  incoming: readonly LauncherHarnessConsoleEntry[]
): readonly LauncherHarnessConsoleEntry[] {
  if (incoming.length === 0) return current
  const bySequence = new Map(current.map((entry) => [entry.seq, entry]))
  for (const entry of incoming) bySequence.set(entry.seq, entry)
  return [...bySequence.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-CONSOLE_FEED_LIMIT)
}

/** Subscribes once per window to the main-process console push channel. */
function subscribeConsoleAppend(): void {
  const launcherHarness = window.dshLauncher?.launcherHarness
  if (consoleSubscribed || launcherHarness === undefined) return
  if (typeof launcherHarness.onConsoleAppend !== 'function') return
  consoleSubscribed = true
  launcherHarness.onConsoleAppend((entries) => {
    consoleFeed.value = mergeConsoleEntries(consoleFeed.value, entries)
  })
}

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
  // Snapshots and push events are merged, never replaced, so a slow getState
  // reply cannot roll the live feed back past already-appended entries.
  consoleFeed.value = mergeConsoleEntries(consoleFeed.value, result.data.console)
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

/** Step-position progress the statusbar renders as a determinate fill. */
export interface LauncherOperationProgress {
  /** One-based position of the step currently running. */
  readonly stepPosition: number
  readonly totalSteps: number
  readonly elapsedSeconds: number
}

/** A completed step's console record; the format is owned by the main process. */
const COMPLETED_STEP_PATTERN = /finished in \d+s\./u
/** The fetch step only update and branch switches run before the six build steps. */
const FETCH_STEP_PATTERN = /^Fetching DSH updates from origin/u
/** The switch pipeline's fixed step count; mirrors `#switchCheckout` in main. */
const SWITCH_CHECKOUT_STEP_COUNT = 6

/**
 * Derives step-position progress from the live console feed.
 *
 * The statusbar's indeterminate bar cannot show progress, and its animation is
 * neutralized under reduced-motion preferences; a determinate fill from real
 * step completions moves without any animation at all.
 */
export function computeOperationStepProgress(
  operation: LauncherHarnessOperation,
  entries: readonly LauncherHarnessConsoleEntry[],
  startedAtMilliseconds: number,
  nowMilliseconds: number
): LauncherOperationProgress | undefined {
  if (operation !== 'switch' && operation !== 'update' && operation !== 'refresh') return undefined
  let completedSteps = 0
  let sawFetchStep = false
  for (const entry of entries) {
    if (entry.stream !== 'launcher') continue
    if (FETCH_STEP_PATTERN.test(entry.text)) sawFetchStep = true
    if (COMPLETED_STEP_PATTERN.test(entry.text)) completedSteps += 1
  }
  const totalSteps =
    operation === 'refresh' ? 1 : SWITCH_CHECKOUT_STEP_COUNT + (sawFetchStep ? 1 : 0)
  return {
    stepPosition: Math.min(completedSteps + 1, totalSteps),
    totalSteps,
    elapsedSeconds: Math.max(0, Math.round((nowMilliseconds - startedAtMilliseconds) / 1000))
  }
}

async function applyOperation(
  operation: LauncherHarnessOperation,
  ipcOperation: () => ReturnType<
    NonNullable<typeof window.dshLauncher>['launcherHarness']['update']
  >
): Promise<void> {
  loading.value = true
  activeOperation.value = operation
  operationStartedAtMs = Date.now()
  operationStartIndex = consoleFeed.value.length
  try {
    const result = await ipcOperation()
    if (!result.ok) {
      error.value = result.code
      // A rejected operation still leaves its failure record in the console,
      // so the state is re-read before the busy flag clears.
      await readState()
      error.value = result.code
      return
    }
    state.value = result.data
    consoleFeed.value = mergeConsoleEntries(consoleFeed.value, result.data.console)
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
    // Console output arrives by push; this subscription is idempotent and
    // outlives every component because the feed state is module-level.
    subscribeConsoleAppend()
    void refresh()
    // State transitions (preparing, starting, running) stay on the periodic
    // read: they are low-frequency facts, unlike the streamed console feed.
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
    consoleFeed,
    loading,
    error,
    activeOperation,
    operationProgress,
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
