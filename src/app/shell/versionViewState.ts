import { computed, reactive, ref } from 'vue'
import type { LauncherHarnessPluginView } from '@/shared/contracts'
import {
  harnessState,
  adoptPlugin,
  installPlugin,
  uninstallPlugin,
  updatePlugin
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
const gitInstallOpen = ref(false)
const selectedCatalogIds = reactive(new Set<string>())
const selectedCatalogCount = computed(() => selectedCatalogIds.size)
const selectedPluginNames = reactive(new Set<string>())
const catalogSearch = ref('')
const catalogCategory = ref<string>(ALL_CATEGORIES)

/** One user-facing extension assembled from the packages installed from one source. */
export interface InstalledExtensionGroup {
  readonly key: string
  readonly primaryPlugin: LauncherHarnessPluginView
  readonly packages: readonly LauncherHarnessPluginView[]
  readonly sourceUrl?: string
  readonly localPath?: string
  readonly managedGitPackages: readonly LauncherHarnessPluginView[]
}

/** The only update operation that can change every package in one extension together. */
export type ExtensionUpdateMode = 'managed' | 'adopt'

/** Groups companion runtime and settings packages from the same explicit extension source. */
export function installedExtensionGroupsOf(
  plugins: readonly LauncherHarnessPluginView[]
): readonly InstalledExtensionGroup[] {
  const grouped = new Map<string, LauncherHarnessPluginView[]>()
  for (const plugin of plugins) {
    if (plugin.origin !== 'user') continue
    const key = extensionSourceKey(plugin)
    const entries = grouped.get(key) ?? []
    entries.push(plugin)
    grouped.set(key, entries)
  }
  return [...grouped.entries()]
    .map(([key, packages]) => {
      const primaryPlugin = packages.find((plugin) => !isSettingsUiPackage(plugin)) ?? packages[0]
      if (primaryPlugin === undefined)
        throw new Error('An installed extension must contain a package.')
      return {
        key,
        primaryPlugin,
        packages,
        ...(primaryPlugin.sourceUrl === undefined ? {} : { sourceUrl: primaryPlugin.sourceUrl }),
        ...(primaryPlugin.localPath === undefined ? {} : { localPath: primaryPlugin.localPath }),
        managedGitPackages: packages.filter((plugin) => plugin.managedGitSource !== undefined)
      }
    })
    .sort((left, right) => left.primaryPlugin.name.localeCompare(right.primaryPlugin.name))
}

/** The DSH client package is a settings surface paired with its runtime tool package. */
export function isSettingsUiPackage(plugin: LauncherHarnessPluginView): boolean {
  return plugin.name.includes('/dsh-client-ui-')
}

function extensionSourceKey(plugin: LauncherHarnessPluginView): string {
  if (plugin.sourceUrl !== undefined) return `source:${comparableSource(plugin.sourceUrl)}`
  if (plugin.localPath !== undefined) return `local:${plugin.localPath}`
  return `package:${plugin.name}`
}

/** User-installed extension groups currently projected from the native DSH profile. */
const installedExtensionGroups = computed(() => {
  const state = harnessState.value
  return state?.kind === 'ready' ? installedExtensionGroupsOf(state.plugins) : []
})

/** In-box packages required for the ordinary DSH Web profile. */
const bundledPlugins = computed(() => {
  const state = harnessState.value
  return state?.kind === 'ready'
    ? state.plugins.filter((plugin) => plugin.origin === 'default')
    : []
})

/** Count extensions rather than individual companion packages in the toolbar. */
const selectedPluginCount = computed(
  () => installedExtensionGroups.value.filter((group) => isExtensionGroupSelected(group)).length
)

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

/** Whether every package that comprises this extension is selected for removal. */
function isExtensionGroupSelected(group: InstalledExtensionGroup): boolean {
  return group.packages.every((plugin) => selectedPluginNames.has(plugin.name))
}

/**
 * A direct local checkout is migrated only on the user's explicit update
 * action. A managed Git extension updates in place; partial groups are not
 * offered a misleading partial update.
 */
function extensionUpdateMode(group: InstalledExtensionGroup): ExtensionUpdateMode | undefined {
  if (group.packages.every((plugin) => plugin.managedGitSource !== undefined)) return 'managed'
  if (
    group.packages.every(
      (plugin) =>
        plugin.managedGitSource === undefined &&
        plugin.localPath !== undefined &&
        plugin.sourceUrl?.startsWith('https://github.com/') === true
    )
  ) {
    return 'adopt'
  }
  return undefined
}

/** Whether at least one managed package in this extension has a fetched newer commit. */
function hasExtensionUpdate(group: InstalledExtensionGroup): boolean {
  return group.packages.some((plugin) => plugin.managedGitSource?.updateAvailable === true)
}

/** Selects or clears every package belonging to one user-facing extension. */
function toggleExtensionGroupSelection(group: InstalledExtensionGroup): void {
  const selected = isExtensionGroupSelected(group)
  for (const plugin of group.packages) {
    if (selected) selectedPluginNames.delete(plugin.name)
    else selectedPluginNames.add(plugin.name)
  }
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
  const removable = installedExtensionGroups.value
  const allSelected =
    removable.length > 0 && removable.every((group) => isExtensionGroupSelected(group))
  for (const group of removable) {
    for (const plugin of group.packages) {
      if (allSelected) selectedPluginNames.delete(plugin.name)
      else selectedPluginNames.add(plugin.name)
    }
  }
}

/** Removes every checked user-installed plugin sequentially through the DSH CLI. */
async function uninstallSelected(): Promise<void> {
  for (const name of [...selectedPluginNames]) {
    await uninstallPlugin({ name })
  }
  selectedPluginNames.clear()
}

/** Removes every package owned by one displayed extension source. */
async function uninstallExtensionGroup(group: InstalledExtensionGroup): Promise<void> {
  for (const plugin of group.packages) {
    await uninstallPlugin({ name: plugin.name })
  }
  for (const plugin of group.packages) selectedPluginNames.delete(plugin.name)
}

/** Updates a Git-managed extension or explicitly adopts its legacy local source first. */
async function updateExtensionGroup(group: InstalledExtensionGroup): Promise<void> {
  const mode = extensionUpdateMode(group)
  if (mode === 'managed') {
    for (const plugin of group.packages) {
      await updatePlugin({ name: plugin.name })
    }
    return
  }
  if (mode === 'adopt') {
    for (const plugin of group.packages) {
      await adoptPlugin({ name: plugin.name })
    }
  }
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
    .map((entry) => ({ kind: 'git' as const, url: entry.url }))
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
  gitInstallOpen,
  selectedCatalogIds,
  selectedCatalogCount,
  selectedPluginNames,
  selectedPluginCount,
  installedExtensionGroups,
  bundledPlugins,
  catalogSearch,
  catalogCategory,
  catalogCategories,
  filteredCatalogEntries,
  isCatalogEntryInstalled,
  isExtensionGroupSelected,
  extensionUpdateMode,
  hasExtensionUpdate,
  toggleCatalogSelection,
  toggleExtensionGroupSelection,
  toggleAllVisibleCatalog,
  toggleAllPlugins,
  installSelected,
  uninstallSelected,
  uninstallExtensionGroup,
  updateExtensionGroup
}
