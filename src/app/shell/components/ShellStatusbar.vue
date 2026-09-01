<script setup lang="ts">
defineProps<{
  readonly protocolLabel: string
  readonly protocolVersion: string
  readonly scopeLabel: string
  readonly scopeValue: string
  readonly operationLabel?: string
}>()
</script>

<template>
  <footer class="statusbar" :data-busy="operationLabel !== undefined">
    <span
      v-if="operationLabel"
      class="statusbar-progress"
      role="status"
      aria-live="polite"
      :aria-label="operationLabel"
    >
      <span class="statusbar-progress-track" aria-hidden="true">
        <span class="statusbar-progress-bar" />
      </span>
      <span class="statusbar-progress-text">{{ operationLabel }}</span>
    </span>
    <template v-else>
      <span>{{ protocolLabel }} · {{ protocolVersion }}</span>
      <span>{{ scopeLabel }} · {{ scopeValue }}</span>
    </template>
  </footer>
</template>
