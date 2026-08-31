import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  LauncherHarnessState,
  SwitchLauncherHarnessBranchRequest,
  SwitchLauncherHarnessVersionRequest
} from '@/shared/contracts'

/** Renderer state for the one Launcher-owned Harness checkout. */
export function useLauncherHarness() {
  const state = ref<LauncherHarnessState>()
  const loading = ref(false)
  const error = ref<string>()

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
    loading.value = true
    try {
      const result = await window.dshLauncher.launcherHarness.start()
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

  /** Stops only the DSH Web process created by the Launcher. */
  async function stop(): Promise<void> {
    if (!window.dshLauncher || !ready.value || state.value?.launch.kind !== 'running') return
    loading.value = true
    try {
      const result = await window.dshLauncher.launcherHarness.stop()
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

  /** Fetches remote refs without changing the active checkout. */
  async function refreshVersions(): Promise<void> {
    if (!window.dshLauncher || loading.value) return
    await applyOperation(() => window.dshLauncher!.launcherHarness.refreshVersions())
  }

  /** Fetches and switches to the newest remote master commit. */
  async function update(): Promise<void> {
    if (!window.dshLauncher || loading.value) return
    await applyOperation(() => window.dshLauncher!.launcherHarness.update())
  }

  /** Switches only to the selected complete Git commit. */
  async function switchVersion(request: SwitchLauncherHarnessVersionRequest): Promise<void> {
    if (!window.dshLauncher || loading.value) return
    await applyOperation(() => window.dshLauncher!.launcherHarness.switchVersion(request))
  }

  /** Fetches and switches to an origin branch selected from the current list. */
  async function switchBranch(request: SwitchLauncherHarnessBranchRequest): Promise<void> {
    if (!window.dshLauncher || loading.value) return
    await applyOperation(() => window.dshLauncher!.launcherHarness.switchBranch(request))
  }

  async function applyOperation(
    operation: () => ReturnType<NonNullable<typeof window.dshLauncher>['launcherHarness']['update']>
  ): Promise<void> {
    loading.value = true
    try {
      const result = await operation()
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
    ready,
    canStart,
    refresh,
    start,
    stop,
    refreshVersions,
    update,
    switchVersion,
    switchBranch
  }
}
