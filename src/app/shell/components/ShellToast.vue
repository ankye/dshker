<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly detail: string
  readonly code: string
  readonly codeLabel: string
  readonly dismissLabel: string
}>()

const emit = defineEmits<{
  dismiss: []
}>()
</script>

<template>
  <div class="shell-toast" role="alert" aria-live="assertive">
    <div class="shell-toast-heading">
      <strong>{{ title }}</strong>
      <button
        class="shell-toast-dismiss"
        type="button"
        :aria-label="dismissLabel"
        @click="emit('dismiss')"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
    <p class="shell-toast-detail">{{ detail }}</p>
    <!-- The raw code stays available for support without being the message. -->
    <p class="shell-toast-code">
      <span>{{ codeLabel }}</span>
      <code>{{ code }}</code>
    </p>
  </div>
</template>
