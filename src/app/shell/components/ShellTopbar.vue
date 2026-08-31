<script setup lang="ts">
defineProps<{
  readonly kicker: string
  readonly title: string
  readonly subtitle: string
  readonly status: string
  readonly statusKind: 'loading' | 'ready' | 'blocked'
}>()
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <p class="eyebrow">{{ kicker }}</p>
      <h1>{{ title }}</h1>
      <p class="brand-subtitle">{{ subtitle }}</p>
    </div>
    <p class="status-chip" :data-kind="statusKind" role="status">{{ status }}</p>
  </header>
</template>
