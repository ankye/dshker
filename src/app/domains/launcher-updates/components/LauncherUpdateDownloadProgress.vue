<script setup lang="ts">
import { computed } from 'vue'
import type { LauncherUpdateDownloadState } from '@/shared/contracts'

const props = defineProps<{
  readonly state: LauncherUpdateDownloadState
  readonly progressLabel: string
  readonly downloadingLabel: string
  readonly downloadedLabel: string
}>()

const percentage = computed(() => {
  if (props.state.kind !== 'downloading' || props.state.totalBytes === undefined) return undefined
  if (props.state.totalBytes <= 0) return undefined
  return Math.min(100, Math.round((props.state.bytesReceived / props.state.totalBytes) * 100))
})

const statusLabel = computed(() => {
  if (props.state.kind === 'downloaded') return props.downloadedLabel
  return props.downloadingLabel
})
</script>

<template>
  <div
    v-if="state.kind === 'downloading' || state.kind === 'downloaded'"
    class="settings-update-download-progress"
    data-testid="launcher-update-download-progress"
    role="status"
    aria-live="polite"
  >
    <div class="settings-update-download-progress-label">
      <span>{{ state.kind === 'downloading' ? progressLabel : statusLabel }}</span>
      <strong v-if="state.kind === 'downloading' && percentage !== undefined">
        {{ percentage }}%
      </strong>
    </div>
    <div
      v-if="state.kind === 'downloading'"
      class="settings-update-download-progress-track"
      role="progressbar"
      :aria-label="progressLabel"
      :aria-valuemin="0"
      :aria-valuemax="state.totalBytes === undefined ? undefined : 100"
      :aria-valuenow="percentage"
      :data-determinate="percentage !== undefined"
    >
      <span :style="{ width: `${percentage ?? 100}%` }" />
    </div>
  </div>
</template>
