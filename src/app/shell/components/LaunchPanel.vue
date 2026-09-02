<script setup lang="ts">
import launcherIcon from '../../../../resources/dsh-launcher-logo-launcher.png'
import launcherSplash from '../../../../resources/dsh-launcher-splash-orange.png'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import EmptyState from './EmptyState.vue'

const t = useTranslator()
const harness = useLauncherHarness()

/**
 * The panel does not own routing, so a blocked state asks the shell to move
 * instead. Without this, "import a version in Versions" would be advice the
 * user cannot act on from where they are standing.
 */
const emit = defineEmits<{ navigate: ['versions' | 'advanced'] }>()
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
          @click="emit('navigate', 'advanced')"
        >
          {{ t('launch.unavailable.advanced') }}
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

    <!--
      When a version exists, the launch button belongs to the version it acts on
      rather than to a detached corner of the route, so the card owns it.
    -->
    <div v-else class="launch-version-list">
      <article class="launch-version" data-selected="true">
        <div class="launch-version-identity">
          <p class="launch-version-label">{{ t('launch.version') }}</p>
          <strong>{{ harness.state.value.revision }}</strong>
          <p class="launch-version-meta" :title="harness.state.value.harnessDirectory">
            {{ t('launch.commit') }} · {{ harness.state.value.harnessDirectory }}
          </p>
        </div>
        <div class="launch-version-actions">
          <span class="launch-status" :data-running="harness.state.value.launch.kind === 'running'">
            {{
              harness.state.value.launch.kind === 'running'
                ? t('launch.running')
                : t('launch.stopped')
            }}
          </span>
          <button
            class="prototype-button prototype-button--primary launch-primary-action"
            type="button"
            :disabled="!harness.canStart.value"
            @click="harness.start"
          >
            {{ t('launch.start') }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
