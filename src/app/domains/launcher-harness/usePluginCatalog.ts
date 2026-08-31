import { onMounted, ref } from 'vue'
import type { PluginCatalogState } from '@/shared/contracts'

/** Renderer state for the Launcher-owned curated plugin source. */
export function usePluginCatalog() {
  const state = ref<PluginCatalogState>()
  const loading = ref(false)
  const error = ref<string>()

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
      state.value = result.data
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
      state.value = result.data
      error.value = undefined
    } finally {
      loading.value = false
    }
  }

  onMounted(() => void load())
  return { state, loading, error, load, refresh }
}
