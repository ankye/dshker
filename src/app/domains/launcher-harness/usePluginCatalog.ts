import { onMounted, ref } from 'vue'
import type { PluginCatalogState } from '@/shared/contracts'

// Module-level state: the curated plugin source is one Launcher-owned root, so
// every surface observes the same catalog and the same refresh error.
export const pluginCatalogState = ref<PluginCatalogState>()
const loading = ref(false)
const error = ref<string>()

/** Renderer state for the Launcher-owned curated plugin source. */
export function usePluginCatalog() {
  /** Reads an already-synchronized catalog without reaching the network. */
  async function load(): Promise<void> {
    if (!window.dshLauncher) {
      error.value = 'bridge'
      return
    }
    loading.value = true
    try {
      const result = await window.dshLauncher.pluginCatalog.getState()
      if (!result.ok) {
        error.value = result.code
        return
      }
      pluginCatalogState.value = result.data
      error.value = undefined
    } finally {
      loading.value = false
    }
  }

  /** Downloads or updates the exact curated source, then parses its YAML entries. */
  async function refresh(): Promise<void> {
    if (!window.dshLauncher || loading.value) return
    loading.value = true
    try {
      const result = await window.dshLauncher.pluginCatalog.refresh()
      if (!result.ok) {
        error.value = result.code
        return
      }
      pluginCatalogState.value = result.data
      error.value = undefined
    } finally {
      loading.value = false
    }
  }

  onMounted(() => void load())
  return { state: pluginCatalogState, loading, error, load, refresh }
}
