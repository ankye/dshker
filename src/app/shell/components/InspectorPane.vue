<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly description: string
}>()
</script>

<template>
  <aside class="inspector-pane" :aria-label="title">
    <p class="eyebrow">{{ title }}</p>
    <p>{{ description }}</p>
  </aside>
</template>
