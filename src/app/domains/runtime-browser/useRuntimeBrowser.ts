import { onMounted, onUnmounted, ref } from 'vue'
import type {
  RuntimeBrowserHostRenderingInfo,
  RuntimeBrowserPreferences,
  RuntimeBrowserZoomPercent
} from '@/shared/contracts'

const preferences = ref<RuntimeBrowserPreferences>()
const loading = ref(false)
const saving = ref(false)
const error = ref<string>()

function publish(
  result: Awaited<
    ReturnType<NonNullable<typeof window.dshLauncher>['runtimeBrowser']['getPreferences']>
  >
): boolean {
  if (!result.ok) {
    preferences.value = undefined
    error.value = result.code
    return false
  }
  preferences.value = result.data
  error.value = undefined
  return true
}

/** Reads the strict runtime-browser preferences from the registered Settings root. */
async function refresh(): Promise<void> {
  const api = window.dshLauncher?.runtimeBrowser
  if (api === undefined) {
    preferences.value = undefined
    error.value = 'bridge'
    return
  }
  loading.value = true
  try {
    publish(await api.getPreferences())
  } finally {
    loading.value = false
  }
}

/** Persists one admitted zoom before any attached guest adopts it. */
async function setZoom(zoomPercent: RuntimeBrowserZoomPercent): Promise<boolean> {
  const api = window.dshLauncher?.runtimeBrowser
  if (api === undefined || saving.value) {
    if (api === undefined) error.value = 'bridge'
    return false
  }
  saving.value = true
  try {
    return publish(await api.setZoom({ zoomPercent }))
  } finally {
    saving.value = false
  }
}

/** Reads current host/display rendering facts without exposing any guest address. */
async function getHostRenderingInfo(): Promise<RuntimeBrowserHostRenderingInfo | undefined> {
  const api = window.dshLauncher?.runtimeBrowser
  if (api === undefined) return undefined
  const result = await api.getHostRenderingInfo()
  return result.ok ? result.data : undefined
}

/** Renderer state for the Launcher-owned DSH Web browser preferences. */
export function useRuntimeBrowser() {
  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    const api = window.dshLauncher?.runtimeBrowser
    if (api !== undefined) {
      unsubscribe = api.onZoomChange((result) => {
        publish(result)
      })
    }
    void refresh()
  })
  onUnmounted(() => unsubscribe?.())
  return { preferences, loading, saving, error, refresh, setZoom, getHostRenderingInfo }
}
