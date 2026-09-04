<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '@/app/domains/launcher-harness'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { ALL_CATEGORIES, isSettingsUiPackage, versionView } from '../versionViewState'
import EmptyState from './EmptyState.vue'
import VersionStageActions from './VersionStageActions.vue'

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
const gitPluginUrl = ref('')

// The curated catalog holds thousands of entries; rendering them all at once
// makes the tab unusable, so rows are paged and a filter change resets the page.
const visibleCatalogPage = computed(() =>
  versionView.filteredCatalogEntries.value.slice(0, catalogPageSize.value)
)

watch([versionView.catalogSearch, versionView.catalogCategory], () => {
  catalogPageSize.value = CATALOG_PAGE_STEP
})

watch(activeTab, () => {
  versionView.gitInstallOpen.value = false
})

watch(branchPickerOpen, (open) => {
  if (open && harness.state.value?.currentBranch !== undefined) {
    selectedBranch.value = harness.state.value.currentBranch
  }
})

/** The core list renders whenever main-repository history is readable. */
const coreListVisible = computed(() => {
  const state = harness.state.value
  return state !== undefined && (state.kind === 'ready' || state.commits.length > 0)
})

const visibleVersions = computed(() => {
  const state = harness.state.value
  if (state === undefined || (state.kind !== 'ready' && state.commits.length === 0)) return []
  return activeCoreTab.value === 'stable'
    ? state.stableVersions.map((version) => ({ ...version, versionId: version.tag }))
    : state.commits.map((version) => ({
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
  const state = harness.state.value
  if (state === undefined || (state.kind !== 'ready' && state.branches.length === 0)) {
    return [placeholder]
  }
  return [placeholder, ...state.branches.map((branch) => ({ value: branch, label: branch }))]
})

async function switchBranch(): Promise<void> {
  if (!selectedBranch.value) return
  await harness.switchBranch({ branch: selectedBranch.value })
  branchPickerOpen.value = false
}

function openBranchPicker(): void {
  if (harness.state.value?.kind !== 'ready') return
  branchPickerOpen.value = true
}

function isCurrentVersion(version: { readonly hash: string }): boolean {
  return harness.state.value?.revision === version.hash
}

async function switchFromCheckbox(commit: string): Promise<void> {
  if (harness.loading.value) return
  await harness.switchVersion({ commit })
}

async function installGitPlugin(): Promise<void> {
  const url = gitPluginUrl.value.trim()
  if (url.length === 0 || harness.loading.value) return
  await harness.installPlugin({ source: { kind: 'git', url } })
  if (harness.error.value !== undefined) return
  gitPluginUrl.value = ''
  versionView.gitInstallOpen.value = false
}

/** Explains the two in-box packages that must remain present for DSH Web to launch. */
function bundledPluginDescription(name: string): string {
  if (name === '@deepseek-ai/dsh-base') return t('versions.plugins.bundledBase')
  if (name === '@deepseek-ai/dsh-web-app') return t('versions.plugins.bundledWebApp')
  return t('versions.plugins.bundledOther')
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
      <VersionStageActions />
    </div>

    <section v-if="activeTab === 'core'" class="version-tab-panel" role="tabpanel">
      <!--
        The list renders whenever the Git history is readable, even if the
        active version is not built: an interrupted switch must leave the user
        able to recover by switching again, not staring at an empty list.
      -->
      <template v-if="coreListVisible">
        <p
          v-if="harness.state.value?.kind !== 'ready'"
          class="version-meta-line core-not-built-notice"
          role="status"
        >
          {{ t('versions.core.notBuiltNotice') }} {{ harness.state.value?.message }}
        </p>
        <div class="version-scope-row">
          <p class="version-meta-line" :title="harness.state.value?.revision">
            <code>{{ harness.state.value?.remoteUrl ?? '—' }}</code>
            <span aria-hidden="true">·</span>
            <code>{{ harness.state.value?.currentBranch ?? '—' }}</code>
            <span aria-hidden="true">·</span>
            <code>{{ harness.state.value?.revision?.slice(0, 7) }}</code>
          </p>
          <div class="core-scope-actions">
            <button
              class="version-action-button"
              type="button"
              :disabled="harness.loading.value || harness.state.value?.launch.kind === 'running'"
              @click="openBranchPicker"
            >
              {{ t('versions.core.switchBranch') }}
            </button>
          </div>
        </div>
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
        <div class="core-version-tabs core-version-tabs--content" role="tablist">
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
                    v-if="version.hash !== harness.state.value?.revision"
                    class="version-action-button version-switch-action"
                    type="button"
                    :disabled="
                      harness.loading.value || harness.state.value?.launch.kind === 'running'
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

    <section v-else-if="activeTab === 'plugins'" class="version-tab-panel" role="tabpanel">
      <template v-if="harness.state.value?.kind === 'ready'">
        <p class="version-tab-summary" :title="t('versions.plugins.installedDescription')">
          <strong>{{ t('versions.plugins.installedTitle') }}</strong>
          <span>{{ t('versions.plugins.installedDescription') }}</span>
        </p>
        <div v-if="versionView.selectedPluginCount.value > 0" class="version-list-actions">
          <button
            class="version-action-button version-action-button--primary"
            type="button"
            :disabled="harness.loading.value"
            data-testid="uninstall-selected-plugins"
            @click="versionView.uninstallSelected"
          >
            {{ t('versions.catalog.uninstallSelected') }} ({{
              versionView.selectedPluginCount.value
            }})
          </button>
        </div>
        <div
          v-if="versionView.installedExtensionGroups.value.length > 0"
          class="version-table-wrap"
        >
          <table class="version-table extension-table">
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
                <th scope="col">{{ t('versions.plugins.extension') }}</th>
                <th scope="col">{{ t('versions.plugins.components') }}</th>
                <th scope="col">{{ t('versions.plugins.source') }}</th>
                <th scope="col">{{ t('versions.plugins.version') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in versionView.installedExtensionGroups.value" :key="group.key">
                <td class="version-select-column">
                  <input
                    class="version-select-check"
                    type="checkbox"
                    :checked="versionView.isExtensionGroupSelected(group)"
                    :disabled="harness.loading.value"
                    :data-testid="`extension-check-${group.primaryPlugin.name}`"
                    :aria-label="t('versions.plugins.uninstall')"
                    @change="versionView.toggleExtensionGroupSelection(group)"
                  />
                </td>
                <td class="plugin-action-cell version-action-column">
                  <div class="plugin-row-actions">
                    <button
                      v-if="versionView.extensionUpdateMode(group) === 'managed'"
                      class="version-action-button version-switch-action"
                      type="button"
                      :disabled="harness.loading.value || !versionView.hasExtensionUpdate(group)"
                      :data-testid="`update-extension-${group.primaryPlugin.name}`"
                      @click="versionView.updateExtensionGroup(group)"
                    >
                      {{ t('versions.plugins.update') }}
                    </button>
                    <button
                      v-if="versionView.extensionUpdateMode(group) === 'adopt'"
                      class="version-action-button version-switch-action"
                      type="button"
                      :disabled="harness.loading.value"
                      :data-testid="`adopt-extension-${group.primaryPlugin.name}`"
                      @click="versionView.updateExtensionGroup(group)"
                    >
                      {{ t('versions.plugins.manage') }}
                    </button>
                    <button
                      class="version-action-button version-switch-action"
                      type="button"
                      :disabled="harness.loading.value"
                      :data-testid="`uninstall-extension-${group.primaryPlugin.name}`"
                      @click="versionView.uninstallExtensionGroup(group)"
                    >
                      {{ t('versions.plugins.uninstall') }}
                    </button>
                  </div>
                </td>
                <td class="extension-name-cell">
                  <code>{{ group.primaryPlugin.name }}</code>
                  <span class="plugin-origin-badge" data-origin="user">
                    {{ t('versions.plugins.originUser') }}
                  </span>
                </td>
                <td class="extension-components-cell">
                  <div
                    v-for="plugin in group.packages"
                    :key="plugin.name"
                    class="extension-component"
                  >
                    <span class="extension-component-role">
                      {{
                        isSettingsUiPackage(plugin)
                          ? t('versions.plugins.settingsComponent')
                          : t('versions.plugins.runtimeComponent')
                      }}
                    </span>
                    <code>{{ plugin.name }}</code>
                  </div>
                </td>
                <td class="catalog-url-cell">
                  <a
                    v-if="group.sourceUrl"
                    :href="group.sourceUrl"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {{ group.sourceUrl }}
                  </a>
                  <span v-else-if="group.localPath" :title="group.localPath">
                    {{ t('versions.plugins.localSource') }}
                  </span>
                  <span v-else>—</span>
                </td>
                <td
                  class="plugin-version-cell"
                  :title="
                    group.managedGitPackages[0]?.managedGitSource?.revision ??
                    group.primaryPlugin.version
                  "
                >
                  <template v-if="group.managedGitPackages[0]?.managedGitSource">
                    {{ t('versions.plugins.gitRevision') }}
                    <code>{{
                      group.managedGitPackages[0].managedGitSource.revision.slice(0, 7)
                    }}</code>
                  </template>
                  <template v-else>
                    {{
                      group.primaryPlugin.localPath
                        ? t('versions.plugins.localSource')
                        : group.primaryPlugin.version || '—'
                    }}
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <EmptyState
          v-else
          icon="inbox"
          fill
          :title="t('versions.plugins.empty')"
          :description="t('versions.plugins.empty.description')"
        />
        <section class="bundled-plugins-panel" :aria-label="t('versions.plugins.bundledTitle')">
          <div>
            <h3>{{ t('versions.plugins.bundledTitle') }}</h3>
            <p>{{ t('versions.plugins.bundledDescription') }}</p>
          </div>
          <dl>
            <div v-for="plugin in versionView.bundledPlugins.value" :key="plugin.name">
              <dt>
                <code>{{ plugin.name }}</code>
              </dt>
              <dd>{{ bundledPluginDescription(plugin.name) }}</dd>
            </div>
          </dl>
        </section>
      </template>
      <EmptyState v-else icon="inbox" fill :title="t('versions.pluginSource.empty')" />
    </section>

    <section v-else class="version-tab-panel catalog-tab-panel" role="tabpanel">
      <!-- Search stays above the results; category selection owns its own
       * persistent column so a long catalog never asks the user to pan sideways. -->
      <template v-if="pluginCatalog.state.value?.kind === 'ready'">
        <div class="catalog-toolbar">
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
          </div>
          <p class="catalog-source-line" :title="pluginCatalog.state.value.revision">
            <code>{{ pluginCatalog.state.value.remoteUrl }}</code>
            <span aria-hidden="true">·</span>
            <code>{{ pluginCatalog.state.value.revision.slice(0, 7) }}</code>
          </p>
        </div>
      </template>
      <div v-if="pluginCatalog.state.value?.kind === 'ready'" class="catalog-workspace">
        <aside class="catalog-category-sidebar" :aria-label="t('versions.catalog.category')">
          <p class="catalog-category-heading">{{ t('versions.catalog.category') }}</p>
          <div class="catalog-category-list" role="tablist" aria-orientation="vertical">
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
        </aside>
        <div class="catalog-results-panel">
          <div class="version-table-wrap">
            <div v-if="versionView.selectedCatalogCount.value > 0" class="version-list-actions">
              <button
                class="version-action-button version-action-button--primary"
                type="button"
                :disabled="harness.loading.value"
                data-testid="install-selected-plugins"
                @click="versionView.installSelected"
              >
                {{ t('versions.catalog.installSelected') }} ({{
                  versionView.selectedCatalogCount.value
                }})
              </button>
            </div>
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
                      @click="harness.installPlugin({ source: { kind: 'git', url: plugin.url } })"
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
        </div>
      </div>
      <EmptyState v-else icon="inbox" fill :title="t('versions.catalog.empty')" />
    </section>

    <Teleport to="body">
      <div
        v-if="versionView.gitInstallOpen.value"
        class="version-install-backdrop"
        @mousedown.self="versionView.gitInstallOpen.value = false"
      >
        <section
          class="version-install-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-plugin-install-title"
        >
          <header>
            <div>
              <h3 id="git-plugin-install-title">{{ t('versions.catalog.gitInstallTitle') }}</h3>
              <p>{{ t('versions.catalog.gitInstallDescription') }}</p>
            </div>
            <button
              class="version-dialog-close"
              type="button"
              :aria-label="t('versions.catalog.cancel')"
              @click="versionView.gitInstallOpen.value = false"
            >
              ×
            </button>
          </header>
          <form class="version-install-form" @submit.prevent="installGitPlugin">
            <label>
              <span>{{ t('versions.catalog.gitSourceLabel') }}</span>
              <input
                v-model="gitPluginUrl"
                class="catalog-git-source-input"
                type="url"
                inputmode="url"
                autocomplete="url"
                :placeholder="t('versions.catalog.gitSourcePlaceholder')"
                :aria-label="t('versions.catalog.gitSourcePlaceholder')"
                data-testid="plugin-git-url"
              />
            </label>
            <footer>
              <button
                class="version-action-button"
                type="button"
                :disabled="harness.loading.value"
                @click="versionView.gitInstallOpen.value = false"
              >
                {{ t('versions.catalog.cancel') }}
              </button>
              <button
                class="version-action-button version-action-button--primary"
                type="submit"
                :disabled="harness.loading.value || gitPluginUrl.trim().length === 0"
                data-testid="install-git-plugin"
              >
                {{ t('versions.catalog.installGit') }}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Teleport>
  </section>
</template>
