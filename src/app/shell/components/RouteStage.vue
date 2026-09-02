<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly description: string
  readonly status: string
  readonly statusKind: 'loading' | 'ready' | 'blocked'
}>()
</script>

<template>
  <section class="route-stage" :aria-label="title">
    <header class="route-stage-header">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
      <div class="route-stage-actions">
        <slot name="actions" />
        <!--
          Bootstrap state rides the route header because the shell no longer has
          a full-width bar; it stays reachable on every route without spending a
          dedicated row on it.
        -->
        <p class="status-chip" :data-kind="statusKind" role="status">{{ status }}</p>
      </div>
    </header>
    <slot />
  </section>
</template>
