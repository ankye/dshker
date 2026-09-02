import { computed, reactive, ref } from 'vue'
import {
  harnessState,
  installPlugin,
  uninstallPlugin
} from '@/app/domains/launcher-harness/useLauncherHarness'
import { pluginCatalogState } from '@/app/domains/launcher-harness/usePluginCatalog'

/** The catalog's "all categories" sentinel, kept distinct from a real category. */
export const ALL_CATEGORIES = '__all__'

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
const selectedPluginNames = reactive(new Set<string>())
const selectedPluginCount = computed(() => selectedPluginNames.size)
const catalogSearch = ref('')
const catalogCategory = ref<string>(ALL_CATEGORIES)

/**
 * Normalizes a git remote for comparison.
 *
 * Catalog records are always HTTPS while an installed plugin's remote may be
 * SSH, so both sides are reduced to one comparable form before matching.
 */
function comparableSource(url: string): string {
  return url
    .trim()
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/^ssh:\/\/git@/u, 'https://')
    .replace(/^git@([^:/]+)[:/]/u, 'https://$1/')
    .replace(/^http:/u, 'https:')
    .toLowerCase()
}

/** Git remotes of every user-installed plugin, for catalog install matching. */
const installedSources = computed(() => {
  const state = harnessState.value
  if (state?.kind !== 'ready') return new Set<string>()
  const sources = new Set<string>()
  for (const plugin of state.plugins) {
    if (plugin.origin !== 'user' || plugin.sourceUrl === undefined) continue
    sources.add(comparableSource(plugin.sourceUrl))
  }
  return sources
})

/** Every category present in the catalog, ordered for a stable tab strip. */
const catalogCategories = computed(() => {
  const catalog = pluginCatalogState.value
  if (catalog?.kind !== 'ready') return [] as readonly string[]
  return [...new Set(catalog.entries.map((entry) => entry.category))].sort((left, right) =>
    left.localeCompare(right)
  )
})

/**
 * The catalog rows to display: category filter first, then a free-text match
 * over name, category, description, and source URL.
 */
const filteredCatalogEntries = computed(() => {
  const catalog = pluginCatalogState.value
  if (catalog?.kind !== 'ready') return []
  const query = catalogSearch.value.trim().toLowerCase()
  return catalog.entries.filter((entry) => {
    if (catalogCategory.value !== ALL_CATEGORIES && entry.category !== catalogCategory.value) {
      return false
    }
    if (query.length === 0) return true
    return (
      entry.name.toLowerCase().includes(query) ||
      entry.category.toLowerCase().includes(query) ||
      entry.description.toLowerCase().includes(query) ||
      entry.url.toLowerCase().includes(query)
    )
  })
})

/** Reports whether one catalog entry is already installed. */
function isCatalogEntryInstalled(url: string): boolean {
  return installedSources.value.has(comparableSource(url))
}

function togglePluginSelection(name: string): void {
  if (selectedPluginNames.has(name)) {
    selectedPluginNames.delete(name)
    return
  }
  selectedPluginNames.add(name)
}

/** Checks or clears every visible catalog row that is not already installed. */
function toggleAllVisibleCatalog(): void {
  const installable = filteredCatalogEntries.value.filter(
    (entry) => !isCatalogEntryInstalled(entry.url)
  )
  const allSelected =
    installable.length > 0 && installable.every((entry) => selectedCatalogIds.has(entry.id))
  for (const entry of installable) {
    if (allSelected) selectedCatalogIds.delete(entry.id)
    else selectedCatalogIds.add(entry.id)
  }
}

/** Checks or clears every removable installed plugin. */
function toggleAllPlugins(): void {
  const state = harnessState.value
  if (state?.kind !== 'ready') return
  const removable = state.plugins.filter((plugin) => plugin.origin === 'user')
  const allSelected =
    removable.length > 0 && removable.every((plugin) => selectedPluginNames.has(plugin.name))
  for (const plugin of removable) {
    if (allSelected) selectedPluginNames.delete(plugin.name)
    else selectedPluginNames.add(plugin.name)
  }
}

/** Removes every checked user-installed plugin sequentially through the DSH CLI. */
async function uninstallSelected(): Promise<void> {
  for (const name of [...selectedPluginNames]) {
    await uninstallPlugin({ name })
  }
  selectedPluginNames.clear()
}

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
  selectedPluginNames,
  selectedPluginCount,
  catalogSearch,
  catalogCategory,
  catalogCategories,
  filteredCatalogEntries,
  isCatalogEntryInstalled,
  toggleCatalogSelection,
  togglePluginSelection,
  toggleAllVisibleCatalog,
  toggleAllPlugins,
  installSelected,
  uninstallSelected
}
