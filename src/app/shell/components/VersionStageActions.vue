<script setup lang="ts">
import { useLauncherHarness, usePluginCatalog } from '@/app/domains/launcher-harness'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { versionView } from '../versionViewState'

const t = useTranslator()
const harness = useLauncherHarness()
const pluginCatalog = usePluginCatalog()
</script>

<template>
  <div
    v-if="versionView.activeVersionTab.value === 'core' && harness.state.value?.kind === 'ready'"
    class="version-toolbar-actions"
  >
    <div class="version-toolbar-group">
      <button
        class="version-action-button version-action-button--icon"
        type="button"
        :disabled="harness.loading.value"
        data-testid="refresh-core-versions"
        @click="harness.refreshVersions"
      >
        <svg class="version-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0 2.1 5.4" />
          <path d="M20 4v7h-7" />
        </svg>
        {{ t('versions.core.refresh') }}
      </button>
    </div>
    <div class="version-toolbar-group">
      <button
        class="version-action-button version-action-button--primary"
        type="button"
        :disabled="harness.loading.value || harness.state.value.launch.kind === 'running'"
        @click="harness.update"
      >
        {{ t('versions.core.update') }}
      </button>
    </div>
  </div>
  <div v-else-if="versionView.activeVersionTab.value === 'plugins'" class="version-toolbar-actions">
    <button
      class="version-action-button version-action-button--icon"
      type="button"
      :disabled="harness.loading.value"
      data-testid="refresh-installed-plugins"
      @click="harness.refreshPlugins"
    >
      <svg class="version-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0 2.1 5.4" />
        <path d="M20 4v7h-7" />
      </svg>
      {{ t('versions.plugins.refresh') }}
    </button>
  </div>
  <div v-else-if="versionView.activeVersionTab.value === 'catalog'" class="version-toolbar-actions">
    <div class="version-toolbar-group">
      <button
        class="version-action-button version-action-button--icon"
        type="button"
        :disabled="pluginCatalog.loading.value"
        data-testid="refresh-plugin-catalog"
        @click="pluginCatalog.refresh"
      >
        <svg class="version-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0 2.1 5.4" />
          <path d="M20 4v7h-7" />
        </svg>
        {{ t('versions.catalog.refresh') }}
      </button>
    </div>
    <div class="version-toolbar-group">
      <button
        class="version-action-button"
        type="button"
        :disabled="harness.loading.value"
        data-testid="open-git-plugin-install"
        @click="versionView.gitInstallOpen.value = true"
      >
        {{ t('versions.catalog.installGit') }}
      </button>
      <button
        class="version-action-button"
        type="button"
        :disabled="harness.loading.value"
        data-testid="install-plugin-archive"
        @click="harness.installPluginArchive"
      >
        {{ t('versions.catalog.installLocal') }}
      </button>
    </div>
  </div>
</template>
