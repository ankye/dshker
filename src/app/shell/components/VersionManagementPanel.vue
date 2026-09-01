<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherHarness, usePluginCatalog } from '@/app/domains/launcher-harness'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'
import { versionView } from '../versionViewState'

const t = createTranslator(INITIAL_LOCALE)
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()
const selectedBranch = ref('')
const activeTab = versionView.activeVersionTab
const activeCoreTab = versionView.activeCoreVersionTab
const branchPickerOpen = versionView.branchPickerOpen

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
                <th scope="col">{{ t('versions.core.versionId') }}</th>
                <th scope="col">{{ t('versions.core.change') }}</th>
                <th scope="col">{{ t('versions.core.date') }}</th>
                <th scope="col">{{ t('versions.core.current') }}</th>
                <th scope="col" />
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
                <td>
                  <code>{{ version.versionId }}</code>
                </td>
                <td>{{ version.subject }}</td>
                <td>{{ new Date(version.committedAt).toLocaleString() }}</td>
                <td>
                  <span
                    v-if="version.hash === harness.state.value.revision"
                    class="version-current-mark"
                  >
                    {{ t('versions.core.currentMark') }}
                  </span>
                </td>
                <td>
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
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="source-panel-empty">{{ t('versions.core.empty') }}</p>
    </section>

    <section v-else-if="activeTab === 'plugins'" class="source-panel" role="tabpanel">
      <div v-if="harness.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table">
          <thead>
            <tr>
              <th scope="col">{{ t('versions.plugins.name') }}</th>
              <th scope="col">{{ t('versions.plugins.version') }}</th>
              <th scope="col">{{ t('versions.plugins.origin') }}</th>
              <th scope="col">{{ t('versions.plugins.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plugin in harness.state.value.plugins" :key="plugin.name">
              <td>
                <code>{{ plugin.name }}</code>
              </td>
              <td class="plugin-version-cell">
                {{ plugin.version || '—' }}
              </td>
              <td>
                <span class="plugin-origin-badge" :data-origin="plugin.origin">{{
                  plugin.origin === 'user'
                    ? t('versions.plugins.originUser')
                    : t('versions.plugins.originDefault')
                }}</span>
              </td>
              <td class="plugin-action-cell">
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
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="source-panel-empty">{{ t('versions.pluginSource.empty') }}</p>
    </section>

    <section v-else class="source-panel" role="tabpanel">
      <p
        v-if="pluginCatalog.state.value?.kind === 'ready'"
        class="version-meta-line"
        :title="pluginCatalog.state.value.revision"
      >
        <code>{{ pluginCatalog.state.value.remoteUrl }}</code>
        <span aria-hidden="true">@</span>
        <code>{{ pluginCatalog.state.value.revision.slice(0, 7) }}</code>
      </p>
      <div v-if="pluginCatalog.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table catalog-table">
          <thead>
            <tr>
              <th scope="col" class="version-select-column" />
              <th scope="col">{{ t('versions.catalog.name') }}</th>
              <th scope="col">{{ t('versions.catalog.category') }}</th>
              <th scope="col">{{ t('versions.catalog.descriptionColumn') }}</th>
              <th scope="col">{{ t('versions.catalog.url') }}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="plugin in pluginCatalog.state.value.entries" :key="plugin.id">
              <td class="version-select-column">
                <input
                  class="version-select-check"
                  type="checkbox"
                  :checked="versionView.selectedCatalogIds.has(plugin.id)"
                  :disabled="harness.loading.value"
                  :data-testid="`catalog-check-${plugin.id}`"
                  :aria-label="t('versions.catalog.install')"
                  @change="versionView.toggleCatalogSelection(plugin.id)"
                />
              </td>
              <td class="catalog-name-cell" :title="plugin.name">{{ plugin.name }}</td>
              <td class="catalog-category-cell">{{ plugin.category }}</td>
              <td class="catalog-desc-cell" :title="plugin.description">
                {{ plugin.description }}
              </td>
              <td class="catalog-url-cell">
                <a :href="plugin.url" rel="noreferrer" target="_blank">{{ plugin.url }}</a>
              </td>
              <td class="catalog-action-cell">
                <button
                  class="version-action-button version-switch-action"
                  type="button"
                  :disabled="harness.loading.value"
                  :data-testid="`install-plugin-${plugin.id}`"
                  @click="harness.installPlugin({ source: plugin.url })"
                >
                  {{ t('versions.catalog.install') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="source-panel-empty">{{ t('versions.catalog.empty') }}</p>
    </section>
  </section>
</template>
