<script setup lang="ts">
import launcherIcon from '../../../../icon.png'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'
import { useLauncherHarness } from '@/app/domains/launcher-harness'

const t = createTranslator(INITIAL_LOCALE)
const harness = useLauncherHarness()
</script>

<template>
  <section class="launch-panel" :aria-busy="harness.loading.value">
    <header class="launch-hero">
      <div class="launch-hero-orbit" aria-hidden="true" />
      <img class="launch-hero-icon" :src="launcherIcon" alt="" />
      <div class="launch-hero-content">
        <p class="eyebrow">{{ t('launch.hero.kicker') }}</p>
        <h3>{{ t('launch.hero.title') }}</h3>
        <p>{{ t('launch.hero.description') }}</p>
      </div>
    </header>

    <section v-if="harness.loading.value && !harness.state.value" class="launch-empty">
      {{ t('launch.preparing') }}
    </section>
    <section v-else-if="harness.state.value?.kind === 'preparing'" class="launch-empty">
      {{ t('launch.preparing') }}
    </section>
    <section
      v-else-if="harness.state.value?.kind === 'missing' || harness.state.value?.kind === 'invalid'"
      class="launch-empty"
      role="alert"
    >
      {{ t('launch.unavailable') }}
    </section>
    <section v-else-if="harness.state.value?.kind !== 'ready'" class="launch-empty">
      <p>{{ t('launch.empty') }}</p>
    </section>
    <div v-else class="launch-version-list">
      <article class="launch-version" data-selected="true">
        <div>
          <p class="launch-version-label">{{ t('launch.version') }}</p>
          <strong>{{ harness.state.value.revision }}</strong>
          <p class="launch-version-meta">
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
        </div>
      </article>
    </div>

    <div class="launch-primary-footer">
      <button
        class="prototype-button prototype-button--primary launch-primary-action"
        type="button"
        :disabled="!harness.canStart.value"
        @click="harness.start"
      >
        {{ t('launch.start') }}
      </button>
    </div>
  </section>
</template>
