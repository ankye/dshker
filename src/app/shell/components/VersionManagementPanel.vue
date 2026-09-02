<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '@/app/domains/launcher-harness'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { ALL_CATEGORIES, versionView } from '../versionViewState'
import EmptyState from './EmptyState.vue'

/** Rows added per "show more" click; the catalog holds thousands of entries. */
const CATALOG_PAGE_STEP = 100

const t = useTranslator()
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()
const selectedBranch = ref('')
const activeTab = versionView.activeVersionTab
const activeCoreTab = versionView.activeCoreVersionTab
const branchPickerOpen = versionView.branchPickerOpen
const catalogPageSize = ref(CATALOG_PAGE_STEP)

// The curated catalog holds thousands of entries; rendering them all at once
// makes the tab unusable, so rows are paged and a filter change resets the page.
const visibleCatalogPage = computed(() =>
  versionView.filteredCatalogEntries.value.slice(0, catalogPageSize.value)
)

watch([versionView.catalogSearch, versionView.catalogCategory], () => {
  catalogPageSize.value = CATALOG_PAGE_STEP
})

watch(branchPickerOpen, (open) => {
  if (open && harness.state.value?.kind === 'ready') {
    selectedBranch.value = harness.state.value.currentBranch
  }
})

const visibleVersions = computed(() => {
  if (harness.state.value?.kind !== 'ready') return []
  return activeCoreTab.value === 'stable'
    ? harness.state.value.stableVersions.map((version) => ({ ...version, versionId: version.tag }))
    : harness.state.value.commits.map((version) => ({
        ...version,
        versionId: version.hash.slice(0, 7)
      }))
})

const branchOptions = computed<readonly ThemedListboxOption<string>[]>(() => {
  const placeholder: ThemedListboxOption<string> = {
    value: '',
    label: t('versions.core.branchPlaceholder'),
    disabled: true
  }
  if (harness.state.value?.kind !== 'ready') return [placeholder]
  return [
    placeholder,
    ...harness.state.value.branches.map((branch) => ({ value: branch, label: branch }))
  ]
})

async function switchBranch(): Promise<void> {
  if (!selectedBranch.value) return
  await harness.switchBranch({ branch: selectedBranch.value })
  branchPickerOpen.value = false
}

function isCurrentVersion(version: { readonly hash: string }): boolean {
  return harness.state.value?.kind === 'ready' && harness.state.value.revision === version.hash
}

async function switchFromCheckbox(commit: string): Promise<void> {
  if (harness.loading.value) return
  await harness.switchVersion({ commit })
}
</script>

<template>
  <section class="version-management">
    <div class="version-tabs-row">
      <div class="page-tabs" role="tablist" :aria-label="t('versions.title')">
        <button
          v-for="tab in ['core', 'plugins', 'catalog'] as const"
          :key="tab"
          class="page-tab"
          :aria-selected="activeTab === tab"
          :data-active="activeTab === tab"
          role="tab"
          type="button"
          @click="activeTab = tab"
        >
          {{
            tab === 'core'
              ? t('versions.core')
              : tab === 'plugins'
                ? t('versions.plugins')
                : t('versions.catalog')
          }}
        </button>
      </div>
      <div v-if="activeTab === 'core'" class="core-version-tabs" role="tablist">
        <button
          class="core-version-tab"
          :data-active="activeCoreTab === 'stable'"
          type="button"
          role="tab"
          :aria-selected="activeCoreTab === 'stable'"
          @click="activeCoreTab = 'stable'"
        >
          {{ t('versions.core.stable') }}
        </button>
        <button
          class="core-version-tab"
          :data-active="activeCoreTab === 'development'"
          type="button"
          role="tab"
          :aria-selected="activeCoreTab === 'development'"
          @click="activeCoreTab = 'development'"
        >
          {{ t('versions.core.development') }}
        </button>
      </div>
    </div>

    <section v-if="activeTab === 'core'" class="version-tab-panel" role="tabpanel">
      <template v-if="harness.state.value?.kind === 'ready'">
        <p class="version-meta-line" :title="harness.state.value.revision">
          <code>{{ harness.state.value.remoteUrl }}</code>
          <span aria-hidden="true">·</span>
          <code>{{ harness.state.value.currentBranch }}</code>
          <span aria-hidden="true">·</span>
          <code>{{ harness.state.value.revision?.slice(0, 7) }}</code>
        </p>
        <form v-if="branchPickerOpen" class="core-branch-picker" @submit.prevent="switchBranch">
          <ThemedListbox
            v-model="selectedBranch"
            :options="branchOptions"
            :label="t('versions.core.switchBranch')"
            test-id="core-branch"
          />
          <button
            class="prototype-button prototype-button--primary"
            type="submit"
            :disabled="!selectedBranch || harness.loading.value"
          >
            {{ t('versions.core.confirmBranch') }}
          </button>
        </form>
        <div class="version-table-wrap">
          <table class="version-table version-table--core">
            <thead>
              <tr>
                <th scope="col" class="version-select-column">
                  {{ t('versions.core.selected') }}
                </th>
                <th scope="col" class="version-action-column">{{ t('versions.core.switch') }}</th>
                <th scope="col">{{ t('versions.core.versionId') }}</th>
                <th scope="col">{{ t('versions.core.change') }}</th>
                <th scope="col">{{ t('versions.core.date') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="version in visibleVersions" :key="version.versionId">
                <td class="version-select-column">
                  <input
                    class="version-select-check"
                    type="checkbox"
                    :checked="isCurrentVersion(version)"
                    :disabled="harness.loading.value || isCurrentVersion(version)"
                    :data-testid="`version-check-${version.versionId}`"
                    :aria-label="t('versions.core.selected')"
                    @click.prevent="switchFromCheckbox(version.hash)"
                  />
                </td>
                <td class="version-action-column">
                  <button
                    v-if="version.hash !== harness.state.value.revision"
                    class="version-action-button version-switch-action"
                    type="button"
                    :disabled="
                      harness.loading.value || harness.state.value.launch.kind === 'running'
                    "
                    @click="harness.switchVersion({ commit: version.hash })"
                  >
                    {{ t('versions.core.switch') }}
                  </button>
                  <span v-else class="version-current-mark" :title="t('versions.core.currentMark')">
                    {{ t('versions.core.currentMark') }}
                  </span>
                </td>
                <td>
                  <code>{{ version.versionId }}</code>
                </td>
                <td>{{ version.subject }}</td>
                <td>{{ new Date(version.committedAt).toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <EmptyState
        v-else
        icon="inbox"
        fill
        :title="t('versions.core.empty')"
        :description="t('versions.core.empty.description')"
      />
    </section>

    <section v-else-if="activeTab === 'plugins'" class="source-panel" role="tabpanel">
      <div v-if="harness.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table">
          <thead>
            <tr>
              <th scope="col" class="version-select-column">
                <input
                  class="version-select-check"
                  type="checkbox"
                  :disabled="harness.loading.value"
                  :checked="versionView.selectedPluginCount.value > 0"
                  :aria-label="t('versions.plugins.selectAll')"
                  data-testid="select-all-plugins"
                  @change="versionView.toggleAllPlugins()"
                />
              </th>
              <th scope="col" class="version-action-column">
                {{ t('versions.plugins.action') }}
              </th>
              <th scope="col">{{ t('versions.plugins.name') }}</th>
              <th scope="col">{{ t('versions.plugins.source') }}</th>
              <th scope="col">{{ t('versions.plugins.version') }}</th>
              <th scope="col">{{ t('versions.plugins.origin') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plugin in harness.state.value.plugins" :key="plugin.name">
              <td class="version-select-column">
                <input
                  v-if="plugin.origin === 'user'"
                  class="version-select-check"
                  type="checkbox"
                  :checked="versionView.selectedPluginNames.has(plugin.name)"
                  :disabled="harness.loading.value"
                  :data-testid="`plugin-check-${plugin.name}`"
                  :aria-label="t('versions.plugins.uninstall')"
                  @change="versionView.togglePluginSelection(plugin.name)"
                />
              </td>
              <td class="plugin-action-cell version-action-column">
                <button
                  v-if="plugin.origin === 'user'"
                  class="version-action-button version-switch-action"
                  type="button"
                  :disabled="harness.loading.value"
                  :data-testid="`uninstall-plugin-${plugin.name}`"
                  @click="harness.uninstallPlugin({ name: plugin.name })"
                >
                  {{ t('versions.plugins.uninstall') }}
                </button>
                <span v-else class="plugin-version-cell">—</span>
              </td>
              <td>
                <code>{{ plugin.name }}</code>
              </td>
              <td class="catalog-url-cell">
                <a
                  v-if="plugin.sourceUrl"
                  :href="plugin.sourceUrl"
                  rel="noreferrer"
                  target="_blank"
                >
                  {{ plugin.sourceUrl }}
                </a>
                <span v-else-if="plugin.localPath" :title="plugin.localPath">
                  {{ t('versions.plugins.localSource') }}
                </span>
                <span v-else>—</span>
              </td>
              <td class="plugin-version-cell" :title="plugin.version">
                {{ plugin.localPath ? t('versions.plugins.localSource') : plugin.version || '—' }}
              </td>
              <td>
                <span class="plugin-origin-badge" :data-origin="plugin.origin">{{
                  plugin.origin === 'user'
                    ? t('versions.plugins.originUser')
                    : t('versions.plugins.originDefault')
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState v-else icon="inbox" fill :title="t('versions.pluginSource.empty')" />
    </section>

    <section v-else class="source-panel" role="tabpanel">
      <!--
        Search, result count and categories form one toolbar rather than three
        stacked rows: they are all the same act of narrowing a list of thousands
        of entries down to the one the user wants to install.
      -->
      <div v-if="pluginCatalog.state.value?.kind === 'ready'" class="catalog-toolbar">
        <div class="catalog-filter-row">
          <label class="catalog-search-field">
            <svg
              class="catalog-search-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              v-model="versionView.catalogSearch.value"
              class="catalog-search-input"
              type="search"
              :placeholder="t('versions.catalog.searchPlaceholder')"
              :aria-label="t('versions.catalog.searchPlaceholder')"
              data-testid="catalog-search"
            />
          </label>
          <span class="catalog-result-count">
            {{ versionView.filteredCatalogEntries.value.length }} /
            {{ pluginCatalog.state.value.entries.length }}
          </span>
          <p class="catalog-source-line" :title="pluginCatalog.state.value.revision">
            <code>{{ pluginCatalog.state.value.remoteUrl }}</code>
            <span aria-hidden="true">@</span>
            <code>{{ pluginCatalog.state.value.revision.slice(0, 7) }}</code>
          </p>
        </div>
        <div
          class="catalog-category-strip"
          role="tablist"
          :aria-label="t('versions.catalog.category')"
        >
          <button
            class="catalog-category-tab"
            type="button"
            role="tab"
            :aria-selected="versionView.catalogCategory.value === ALL_CATEGORIES"
            :data-active="versionView.catalogCategory.value === ALL_CATEGORIES"
            data-testid="catalog-category-all"
            @click="versionView.catalogCategory.value = ALL_CATEGORIES"
          >
            {{ t('versions.catalog.allCategories') }}
          </button>
          <button
            v-for="category in versionView.catalogCategories.value"
            :key="category"
            class="catalog-category-tab"
            type="button"
            role="tab"
            :aria-selected="versionView.catalogCategory.value === category"
            :data-active="versionView.catalogCategory.value === category"
            :data-testid="`catalog-category-${category}`"
            @click="versionView.catalogCategory.value = category"
          >
            {{ category }}
          </button>
        </div>
      </div>
      <div v-if="pluginCatalog.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table catalog-table">
          <thead>
            <tr>
              <th scope="col" class="version-select-column">
                <input
                  class="version-select-check"
                  type="checkbox"
                  :disabled="harness.loading.value"
                  :checked="versionView.selectedCatalogCount.value > 0"
                  :aria-label="t('versions.catalog.selectAll')"
                  data-testid="select-all-catalog"
                  @change="versionView.toggleAllVisibleCatalog()"
                />
              </th>
              <th scope="col" class="version-action-column">
                {{ t('versions.catalog.install') }}
              </th>
              <th scope="col">{{ t('versions.catalog.name') }}</th>
              <th scope="col">{{ t('versions.catalog.category') }}</th>
              <th scope="col">{{ t('versions.catalog.descriptionColumn') }}</th>
              <th scope="col">{{ t('versions.catalog.url') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="plugin in visibleCatalogPage"
              :key="plugin.id"
              :data-installed="versionView.isCatalogEntryInstalled(plugin.url)"
            >
              <td class="version-select-column">
                <input
                  v-if="!versionView.isCatalogEntryInstalled(plugin.url)"
                  class="version-select-check"
                  type="checkbox"
                  :checked="versionView.selectedCatalogIds.has(plugin.id)"
                  :disabled="harness.loading.value"
                  :data-testid="`catalog-check-${plugin.id}`"
                  :aria-label="t('versions.catalog.install')"
                  @change="versionView.toggleCatalogSelection(plugin.id)"
                />
              </td>
              <td class="catalog-action-cell version-action-column">
                <span
                  v-if="versionView.isCatalogEntryInstalled(plugin.url)"
                  class="plugin-origin-badge"
                  data-origin="user"
                >
                  {{ t('versions.catalog.installed') }}
                </span>
                <button
                  v-else
                  class="version-action-button version-switch-action"
                  type="button"
                  :disabled="harness.loading.value"
                  :data-testid="`install-plugin-${plugin.id}`"
                  @click="harness.installPlugin({ source: plugin.url })"
                >
                  {{ t('versions.catalog.install') }}
                </button>
              </td>
              <td class="catalog-name-cell" :title="plugin.name">{{ plugin.name }}</td>
              <td class="catalog-category-cell">{{ plugin.category }}</td>
              <td class="catalog-desc-cell" :title="plugin.description">
                {{ plugin.description }}
              </td>
              <td class="catalog-url-cell">
                <a :href="plugin.url" rel="noreferrer" target="_blank">{{ plugin.url }}</a>
              </td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="versionView.filteredCatalogEntries.value.length > visibleCatalogPage.length"
          class="managed-secondary-action catalog-more-button"
          type="button"
          data-testid="catalog-show-more"
          @click="catalogPageSize += CATALOG_PAGE_STEP"
        >
          {{ t('versions.catalog.showMore') }}
        </button>
      </div>
      <EmptyState v-else icon="inbox" fill :title="t('versions.catalog.empty')" />
    </section>
  </section>
</template>
