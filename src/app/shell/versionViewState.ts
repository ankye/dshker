import { computed, reactive, ref } from 'vue'
import { installPlugin } from '@/app/domains/launcher-harness/useLauncherHarness'
import { pluginCatalogState } from '@/app/domains/launcher-harness/usePluginCatalog'

/** The three Version management tabs; shared by the stage actions and the panel. */
export type VersionTab = 'core' | 'plugins' | 'catalog'

/** The Core tab's stable/development list selector. */
export type CoreVersionTab = 'stable' | 'development'

// Module-level state: the stage-action row lives in the page header while the
// tables live in the panel body, so both bind the same shared selectors.
const activeVersionTab = ref<VersionTab>('core')
const activeCoreVersionTab = ref<CoreVersionTab>('stable')
const branchPickerOpen = ref(false)
const selectedCatalogIds = reactive(new Set<string>())
const selectedCatalogCount = computed(() => selectedCatalogIds.size)

function toggleCatalogSelection(pluginId: string): void {
  if (selectedCatalogIds.has(pluginId)) {
    selectedCatalogIds.delete(pluginId)
    return
  }
  selectedCatalogIds.add(pluginId)
}

/** Installs every checked curated source sequentially through the DSH CLI. */
async function installSelected(): Promise<void> {
  const catalog = pluginCatalogState.value
  if (catalog?.kind !== 'ready') return
  const sources = catalog.entries
    .filter((entry) => selectedCatalogIds.has(entry.id))
    .map((entry) => entry.url)
  for (const source of sources) {
    await installPlugin({ source })
  }
  selectedCatalogIds.clear()
}

/** Shared Version-management view state bound by the header actions and panel. */
export const versionView = {
  activeVersionTab,
  activeCoreVersionTab,
  branchPickerOpen,
  selectedCatalogIds,
  selectedCatalogCount,
  toggleCatalogSelection,
  installSelected
}
