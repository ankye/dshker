<script setup lang="ts">
defineProps<{
  readonly title: string
  readonly description: string
  readonly status: string
  readonly statusKind: 'loading' | 'ready' | 'blocked'
  /** Lets an action-led route reserve the top edge for its own content. */
  readonly headerVisible?: boolean
  /** Keeps a route-owned consequential action outside the scrollable content plane. */
  readonly footerVisible?: boolean
}>()
</script>

<template>
  <section class="route-stage" :aria-label="title">
    <header v-if="headerVisible !== false" class="route-stage-header">
      <h2>{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
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
    <div class="route-stage-content">
      <slot />
    </div>
    <footer v-if="footerVisible" class="route-stage-footer">
      <slot name="footer" />
    </footer>
  </section>
</template>
