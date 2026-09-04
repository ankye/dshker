<script setup lang="ts">
defineProps<{
  readonly protocolLabel: string
  readonly protocolVersion: string
  readonly scopeLabel: string
  readonly scopeValue: string
  readonly operationLabel?: string
  /**
   * Filled fraction (0–1) when the operation reports real step progress.
   *
   * Undefined keeps the indeterminate slide. A determinate fill is the only
   * progress presentation that still moves when the OS reduces motion.
   */
  readonly operationProgress?: number
}>()

const emit = defineEmits<{ progressToggle: [] }>()
</script>

<template>
  <footer class="statusbar" :data-busy="operationLabel !== undefined">
    <!--
      The busy strip is also the console tail's second entry point: it already
      narrates the running operation, so activating it reveals the live output.
      It is a real button with a live text region inside, never both on one
      element.
    -->
    <button
      v-if="operationLabel"
      class="statusbar-progress"
      type="button"
      :aria-label="operationLabel"
      @click="emit('progressToggle')"
    >
      <span class="statusbar-progress-track" aria-hidden="true">
        <span
          class="statusbar-progress-bar"
          :data-determinate="operationProgress !== undefined"
          :style="
            operationProgress === undefined
              ? undefined
              : { width: `${Math.round(Math.min(1, Math.max(0, operationProgress)) * 100)}%` }
          "
        />
      </span>
      <span class="statusbar-progress-text" role="status" aria-live="polite">{{
        operationLabel
      }}</span>
    </button>
    <template v-else>
      <span>{{ protocolLabel }} · {{ protocolVersion }}</span>
      <span>{{ scopeLabel }} · {{ scopeValue }}</span>
    </template>
  </footer>
</template>
