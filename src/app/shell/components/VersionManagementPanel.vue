<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { usePluginCatalog } from '@/app/domains/launcher-harness'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'

type VersionTab = 'core' | 'plugins' | 'catalog'
type CoreVersionTab = 'stable' | 'development'

const t = createTranslator(INITIAL_LOCALE)
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()
const activeTab = ref<VersionTab>('core')
const activeCoreTab = ref<CoreVersionTab>('stable')
const branchPickerOpen = ref(false)
const selectedBranch = ref('')
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

function openBranchPicker(): void {
  if (harness.state.value?.kind !== 'ready') return
  selectedBranch.value = harness.state.value.currentBranch
  branchPickerOpen.value = true
}

async function switchBranch(): Promise<void> {
  if (!selectedBranch.value) return
  await harness.switchBranch({ branch: selectedBranch.value })
  branchPickerOpen.value = false
}
</script>

<template>
  <section class="version-management">
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

    <section v-if="activeTab === 'core'" class="version-tab-panel" role="tabpanel">
      <template v-if="harness.state.value?.kind === 'ready'">
        <header class="core-version-summary">
          <dl>
            <div>
              <dt>{{ t('versions.core.remote') }}</dt>
              <dd>
                <code>{{ harness.state.value.remoteUrl }}</code>
              </dd>
            </div>
            <div>
              <dt>{{ t('versions.core.branch') }}</dt>
              <dd>
                <code>{{ harness.state.value.currentBranch }}</code>
              </dd>
            </div>
            <div>
              <dt>{{ t('versions.core.currentVersion') }}</dt>
              <dd>
                <code>{{ harness.state.value.revision }}</code>
              </dd>
            </div>
          </dl>
          <div class="core-version-actions">
            <button
              class="prototype-button prototype-button--secondary"
              type="button"
              :disabled="harness.loading.value || harness.state.value.launch.kind === 'running'"
              @click="openBranchPicker"
            >
              {{ t('versions.core.switchBranch') }}
            </button>
            <button
              class="prototype-button prototype-button--secondary"
              type="button"
              :disabled="harness.loading.value"
              @click="harness.refreshVersions"
            >
              {{ t('versions.core.refresh') }}
            </button>
            <button
              class="prototype-button prototype-button--secondary"
              type="button"
              :disabled="harness.loading.value || harness.state.value.launch.kind === 'running'"
              @click="harness.update"
            >
              {{ t('versions.core.update') }}
            </button>
          </div>
        </header>
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
        <div class="core-version-tabs" role="tablist">
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
                <th scope="col">{{ t('versions.core.versionId') }}</th>
                <th scope="col">{{ t('versions.core.change') }}</th>
                <th scope="col">{{ t('versions.core.date') }}</th>
                <th scope="col">{{ t('versions.core.current') }}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="version in visibleVersions" :key="version.versionId">
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
                    class="prototype-button prototype-button--secondary version-switch-action"
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
      <h3>{{ t('versions.pluginSource.title') }}</h3>
      <p>{{ t('versions.pluginSource.description') }}</p>
      <div v-if="harness.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table">
          <thead>
            <tr>
              <th scope="col">{{ t('versions.plugins.name') }}</th>
              <th scope="col">{{ t('versions.plugins.version') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plugin in harness.state.value.plugins" :key="plugin.name">
              <td>
                <code>{{ plugin.name }}</code>
              </td>
              <td>{{ plugin.version }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="source-panel-empty">{{ t('versions.pluginSource.empty') }}</p>
    </section>

    <section v-else class="source-panel" role="tabpanel">
      <h3>{{ t('versions.catalog.title') }}</h3>
      <p>{{ t('versions.catalog.description') }}</p>
      <div class="catalog-actions">
        <button
          class="prototype-button prototype-button--secondary"
          type="button"
          :disabled="pluginCatalog.loading.value"
          @click="pluginCatalog.refresh"
        >
          {{ t('versions.catalog.refresh') }}
        </button>
      </div>
      <dl v-if="pluginCatalog.state.value" class="source-path-list">
        <div>
          <dt>{{ t('versions.catalog.remote') }}</dt>
          <dd>
            <code>{{ pluginCatalog.state.value.remoteUrl }}</code>
          </dd>
        </div>
        <div v-if="pluginCatalog.state.value.kind === 'ready'">
          <dt>{{ t('versions.catalog.revision') }}</dt>
          <dd>
            <code>{{ pluginCatalog.state.value.revision }}</code>
          </dd>
        </div>
      </dl>
      <div v-if="pluginCatalog.state.value?.kind === 'ready'" class="version-table-wrap">
        <table class="version-table catalog-table">
          <thead>
            <tr>
              <th scope="col">{{ t('versions.catalog.name') }}</th>
              <th scope="col">{{ t('versions.catalog.category') }}</th>
              <th scope="col">{{ t('versions.catalog.descriptionColumn') }}</th>
              <th scope="col">{{ t('versions.catalog.url') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="plugin in pluginCatalog.state.value.entries" :key="plugin.id">
              <td>{{ plugin.name }}</td>
              <td>{{ plugin.category }}</td>
              <td>{{ plugin.description }}</td>
              <td>
                <a :href="plugin.url" rel="noreferrer" target="_blank">{{ plugin.url }}</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="source-panel-empty">{{ t('versions.catalog.empty') }}</p>
    </section>
  </section>
</template>
