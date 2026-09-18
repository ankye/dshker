import { computed, onMounted, ref } from 'vue'
import type { ApiResult, LauncherUpdateState } from '@/shared/contracts'

const state = ref<LauncherUpdateState>()
const error = ref<string>()
const checking = ref(false)
const downloading = ref(false)
const dismissedLatestVersion = ref<string>()

let startPromise: Promise<void> | undefined
let unsubscribe: (() => void) | undefined
let stateRevision = 0

/** Publishes one authoritative main-process update state. */
function publish(result: ApiResult<LauncherUpdateState>): boolean {
  stateRevision += 1
  if (!result.ok) {
    error.value = result.code
    return false
  }
  state.value = result.data
  error.value = undefined
  return true
}

/**
 * Starts the single renderer subscription and reads the current state.
 *
 * Electron main performs the one non-blocking startup check. The renderer only
 * subscribes before reading so it neither duplicates that request nor misses
 * its result.
 */
export function startLauncherUpdates(): Promise<void> {
  if (startPromise !== undefined) return startPromise
  startPromise = (async () => {
    const api = window.dshLauncher?.launcherUpdates
    if (api === undefined) {
      error.value = 'bridge'
      return
    }

    unsubscribe = api.onStateChange((result) => {
      publish(result)
    })
    const revisionBeforeRead = stateRevision
    try {
      const result = await api.getState()
      // A startup check event can overtake getState. Never replace that newer
      // event with the older snapshot returned by the initial read.
      if (stateRevision === revisionBeforeRead) publish(result)
    } catch {
      error.value = 'bridge'
    }
  })()
  return startPromise
}

/** Runs an explicit GitHub Releases check without marking any other route busy. */
async function check(): Promise<boolean> {
  const api = window.dshLauncher?.launcherUpdates
  if (api === undefined) {
    error.value = 'bridge'
    return false
  }
  if (checking.value || state.value?.kind === 'checking') return false
  checking.value = true
  error.value = undefined
  try {
    try {
      return publish(await api.check())
    } catch {
      error.value = 'bridge'
      return false
    }
  } finally {
    checking.value = false
  }
}

/** Downloads the verified installer asset through the main-process bridge. */
async function downloadInstaller(): Promise<boolean> {
  const api = window.dshLauncher?.launcherUpdates
  if (api === undefined) {
    error.value = 'bridge'
    return false
  }
  if (downloading.value || state.value?.kind !== 'update-available') return false
  downloading.value = true
  error.value = undefined
  try {
    try {
      return publish(await api.downloadInstaller())
    } catch {
      error.value = 'bridge'
      return false
    }
  } finally {
    downloading.value = false
  }
}

/** Hides only the currently offered version for this window session. */
function dismissNotice(): void {
  const current = state.value
  if (current?.kind === 'update-available') dismissedLatestVersion.value = current.latestVersion
}

const notice = computed(() => {
  const current = state.value
  if (
    current?.kind !== 'update-available' ||
    current.latestVersion === dismissedLatestVersion.value
  ) {
    return undefined
  }
  return current
})

/** Shared application-update state for the shell notice and Settings card. */
export function useLauncherUpdates() {
  onMounted(() => {
    void startLauncherUpdates()
  })
  return {
    state,
    error,
    checking,
    downloading,
    notice,
    check,
    downloadInstaller,
    dismissNotice
  }
}

/** Clears singleton state between component tests. */
export function resetLauncherUpdatesForTests(): void {
  unsubscribe?.()
  unsubscribe = undefined
  startPromise = undefined
  stateRevision = 0
  state.value = undefined
  error.value = undefined
  checking.value = false
  downloading.value = false
  dismissedLatestVersion.value = undefined
}
