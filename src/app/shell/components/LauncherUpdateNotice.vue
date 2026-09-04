<script setup lang="ts">
import type { LauncherUpdateState } from '@/shared/contracts'

defineProps<{
  readonly state: Extract<LauncherUpdateState, { readonly kind: 'update-available' }>
  readonly title: string
  readonly versionLabel: string
  readonly downloadLabel: string
  readonly openingLabel: string
  readonly installHint: string
  readonly dismissLabel: string
  readonly errorLabel: string
  readonly opening: boolean
  readonly error?: string
}>()

const emit = defineEmits<{
  dismiss: []
  download: []
}>()
</script>

<template>
  <aside
    class="launcher-update-notice"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    data-testid="launcher-update-notice"
  >
    <div class="launcher-update-notice-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" />
      </svg>
    </div>
    <div class="launcher-update-notice-copy">
      <strong>{{ title }}</strong>
      <p class="launcher-update-notice-version">
        <span>{{ versionLabel }}</span>
        <b>{{ state.currentVersion }}</b>
        <span aria-hidden="true">→</span>
        <b>{{ state.latestVersion }}</b>
      </p>
      <p class="launcher-update-notice-hint">{{ installHint }}</p>
      <p v-if="error" class="launcher-update-notice-error" role="alert">
        {{ errorLabel }} <code>{{ error }}</code>
      </p>
    </div>
    <div class="launcher-update-notice-actions">
      <button
        class="prototype-button prototype-button--primary"
        type="button"
        :disabled="opening"
        :aria-busy="opening"
        data-testid="launcher-update-notice-download"
        @click="emit('download')"
      >
        {{ opening ? openingLabel : downloadLabel }}
      </button>
      <button
        class="launcher-update-notice-dismiss"
        type="button"
        :aria-label="dismissLabel"
        data-testid="launcher-update-notice-dismiss"
        @click="emit('dismiss')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" />
        </svg>
      </button>
    </div>
  </aside>
</template>
