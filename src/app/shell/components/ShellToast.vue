<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly detail: string
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
    <code class="shell-toast-detail">{{ detail }}</code>
  </div>
</template>
