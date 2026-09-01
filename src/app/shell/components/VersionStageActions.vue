<script setup lang="ts">
import { useLauncherHarness, usePluginCatalog } from '@/app/domains/launcher-harness'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'
import { versionView } from '../versionViewState'

const t = createTranslator(INITIAL_LOCALE)
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()

function openBranchPicker(): void {
  if (harness.state.value?.kind !== 'ready') return
  versionView.branchPickerOpen.value = true
}
</script>

<template>
  <div
    v-if="versionView.activeVersionTab.value === 'core' && harness.state.value?.kind === 'ready'"
    class="version-toolbar-actions"
  >
    <button
      class="version-action-button"
      type="button"
      :disabled="harness.loading.value || harness.state.value.launch.kind === 'running'"
      @click="openBranchPicker"
    >
      {{ t('versions.core.switchBranch') }}
    </button>
    <button
      class="version-action-button"
      type="button"
      :disabled="harness.loading.value"
      @click="harness.refreshVersions"
    >
      {{ t('versions.core.refresh') }}
    </button>
    <button
      class="version-action-button version-action-button--primary"
      type="button"
      :disabled="harness.loading.value || harness.state.value.launch.kind === 'running'"
      @click="harness.update"
    >
      {{ t('versions.core.update') }}
    </button>
  </div>
  <div v-else-if="versionView.activeVersionTab.value === 'catalog'" class="version-toolbar-actions">
    <button
      class="version-action-button"
      type="button"
      :disabled="pluginCatalog.loading.value"
      @click="pluginCatalog.refresh"
    >
      {{ t('versions.catalog.refresh') }}
    </button>
    <button
      v-if="versionView.selectedCatalogCount.value > 0"
      class="version-action-button version-action-button--primary"
      type="button"
      :disabled="harness.loading.value"
      data-testid="install-selected-plugins"
      @click="versionView.installSelected"
    >
      {{ t('versions.catalog.installSelected') }} ({{ versionView.selectedCatalogCount.value }})
    </button>
  </div>
</template>
