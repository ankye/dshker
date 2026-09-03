<script setup lang="ts">
import { ref } from 'vue'
import launcherIcon from '../../../../resources/dsh-launcher-logo-launcher.png'
import launcherSplash from '../../../../resources/dsh-launcher-splash-orange.png'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { type LauncherExternalLinkId } from '@/shared/contracts'
import EmptyState from './EmptyState.vue'

const t = useTranslator()
const harness = useLauncherHarness()
const openingLink = ref<LauncherExternalLinkId>()
const sourceLinkFailed = ref(false)

/**
 * The panel does not own routing, so a blocked state asks the shell to move
 * instead. Without this, "import a version in Versions" would be advice the
 * user cannot act on from where they are standing.
 */
const emit = defineEmits<{ navigate: ['versions' | 'settings'] }>()

/** Opens one product-controlled source page through the typed main-process capability. */
async function openSourceLink(linkId: LauncherExternalLinkId): Promise<void> {
  if (openingLink.value !== undefined) return
  const desktopApi = window.dshLauncher
  if (!desktopApi) {
    sourceLinkFailed.value = true
    return
  }
  openingLink.value = linkId
  sourceLinkFailed.value = false
  const result = await desktopApi.externalLinks.open(linkId)
  if (!result.ok) sourceLinkFailed.value = true
  openingLink.value = undefined
}
</script>

<template>
  <section class="launch-panel" :aria-busy="harness.loading.value">
    <header class="launch-hero" :style="{ '--launch-hero-art': `url(${launcherSplash})` }">
      <div class="launch-hero-orbit" aria-hidden="true" />
      <img class="launch-hero-icon" :src="launcherIcon" alt="" />
      <div class="launch-hero-content">
        <p class="eyebrow">{{ t('launch.hero.kicker') }}</p>
        <h3>{{ t('launch.hero.title') }}</h3>
        <p>{{ t('launch.hero.description') }}</p>
      </div>
    </header>

    <EmptyState
      v-if="
        (harness.loading.value && !harness.state.value) || harness.state.value?.kind === 'preparing'
      "
      icon="spinner"
      tone="progress"
      :title="t('launch.preparing')"
      :description="t('launch.preparing.description')"
    />
    <EmptyState
      v-else-if="harness.state.value?.kind === 'missing' || harness.state.value?.kind === 'invalid'"
      icon="alert"
      tone="danger"
      :title="t('launch.unavailable')"
      :description="t('launch.unavailable.description')"
    >
      <template #actions>
        <button
          type="button"
          class="prototype-button prototype-button--primary"
          :disabled="harness.loading.value"
          @click="harness.refresh"
        >
          {{ t('launch.unavailable.retry') }}
        </button>
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          @click="emit('navigate', 'settings')"
        >
          {{ t('launch.unavailable.settings') }}
        </button>
      </template>
    </EmptyState>
    <EmptyState
      v-else-if="harness.state.value?.kind !== 'ready'"
      icon="inbox"
      :title="t('launch.empty')"
      :description="t('launch.empty.description')"
    >
      <template #actions>
        <button
          type="button"
          class="prototype-button prototype-button--primary"
          @click="emit('navigate', 'versions')"
        >
          {{ t('launch.empty.action') }}
        </button>
      </template>
    </EmptyState>

    <div v-else class="launch-workbench">
      <article class="launch-version" data-selected="true">
        <div class="launch-version-identity">
          <p class="eyebrow">{{ t('launch.version') }}</p>
          <h4>{{ harness.state.value.currentBranch }}</h4>
          <p class="launch-version-label">{{ t('launch.commit') }}</p>
          <strong>{{ harness.state.value.revision }}</strong>
        </div>
        <button
          type="button"
          class="prototype-button prototype-button--secondary launch-version-manage"
          @click="emit('navigate', 'versions')"
        >
          {{ t('launch.version.manage') }}
        </button>
      </article>
    </div>

    <section class="launch-introduction" :aria-label="t('launch.introduction.title')">
      <div class="launch-introduction-copy">
        <p class="eyebrow">{{ t('launch.introduction.kicker') }}</p>
        <h4>{{ t('launch.introduction.title') }}</h4>
        <p>{{ t('launch.introduction.description') }}</p>
      </div>
      <dl class="launch-introduction-facts">
        <div>
          <dt>{{ t('launch.introduction.coreVersion') }}</dt>
          <dd>{{ t('launch.introduction.coreVersionValue') }}</dd>
        </div>
        <div>
          <dt>{{ t('launch.introduction.nativeHome') }}</dt>
          <dd>{{ t('launch.introduction.nativeHomeValue') }}</dd>
        </div>
      </dl>
      <div class="launch-open-source">
        <div>
          <strong>{{ t('launch.openSource.title') }}</strong>
          <p>{{ t('launch.openSource.description') }}</p>
        </div>
        <div class="launch-open-source-actions">
          <button
            type="button"
            class="prototype-button prototype-button--secondary launch-source-action"
            :disabled="openingLink !== undefined"
            @click="openSourceLink('launcher-repository')"
          >
            {{ t('launch.openSource.launcher') }}
          </button>
          <button
            type="button"
            class="prototype-button prototype-button--secondary launch-source-action"
            :disabled="openingLink !== undefined"
            @click="openSourceLink('harness-repository')"
          >
            {{ t('launch.openSource.harness') }}
          </button>
        </div>
        <p v-if="sourceLinkFailed" class="launch-open-source-error" role="status">
          {{ t('launch.openSource.failure') }}
        </p>
      </div>
    </section>
  </section>
</template>
