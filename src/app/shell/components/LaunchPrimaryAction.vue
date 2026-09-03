<script setup lang="ts">
import { computed } from 'vue'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { useTranslator } from '@/app/shared/i18n/useLocale'

const t = useTranslator()
const harness = useLauncherHarness()

const launch = computed(() =>
  harness.state.value?.kind === 'ready' ? harness.state.value.launch : undefined
)
const action = computed(() =>
  launch.value?.kind === 'running'
    ? t('launch.stop')
    : launch.value?.kind === 'starting'
      ? t('launch.starting')
      : t('launch.start')
)
const disabled = computed(() => harness.loading.value || launch.value?.kind === 'starting')

/** Starts the selected DSH version, or stops the exact child this Launcher created. */
async function toggleLaunch(): Promise<void> {
  if (launch.value?.kind === 'running') {
    await harness.stop()
    return
  }
  await harness.start()
}
</script>

<template>
  <div v-if="launch" class="launch-footer-action">
    <div class="launch-footer-context">
      <strong>{{ t('launch.title') }}</strong>
      <span>{{ t('launch.description') }}</span>
    </div>
    <span class="launch-status" :data-running="launch.kind === 'running'">
      {{ launch.kind === 'running' ? t('launch.running') : t('launch.stopped') }}
    </span>
    <button
      class="prototype-button prototype-button--primary launch-primary-action"
      type="button"
      :disabled="disabled"
      :aria-busy="launch.kind === 'starting'"
      :data-running="launch.kind === 'running'"
      @click="toggleLaunch"
    >
      <svg class="launch-primary-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path v-if="launch.kind !== 'running'" d="m9 6 9 6-9 6z" fill="currentColor" />
        <rect v-else x="8" y="8" width="8" height="8" rx="1" fill="currentColor" />
      </svg>
      {{ action }}
    </button>
  </div>
</template>
