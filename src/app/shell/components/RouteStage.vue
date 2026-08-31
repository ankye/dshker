<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly description: string
}>()
</script>

<template>
  <section class="route-stage" :aria-label="title">
    <header class="route-stage-header">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </header>
    <slot />
  </section>
</template>
