<script setup lang="ts">
import StateIcon, { type StateIconId } from './StateIcon.vue'

/**
 * The single contract for every non-populated surface: nothing here, blocked,
 * or working. Routes previously each owned a private `*-empty` class, which is
 * why the same condition looked different on three routes. Any new empty,
 * loading, or error surface belongs here rather than in a route stylesheet.
 *
 * `tone` selects semantic colour; it never changes layout. `fill` lets a route
 * that owns its vertical space (console, browser) claim the full area so
 * switching to a populated state does not reflow the route.
 */
withDefaults(
  defineProps<{
    readonly icon: StateIconId
    readonly title: string
    readonly description?: string
    readonly tone?: 'neutral' | 'danger' | 'progress'
    readonly fill?: boolean
  }>(),
  { description: undefined, tone: 'neutral', fill: false }
)
</script>

<template>
  <section
    class="empty-state"
    :data-tone="tone"
    :data-fill="fill ? 'true' : 'false'"
    :role="tone === 'danger' ? 'alert' : 'status'"
  >
    <StateIcon class="empty-state-icon" :icon="icon" />
    <p class="empty-state-title">{{ title }}</p>
    <p v-if="description" class="empty-state-description">{{ description }}</p>
    <!--
      Actions are the point of this component: a state that reports a problem
      without offering a way forward leaves the user stranded.
    -->
    <div v-if="$slots.actions" class="empty-state-actions">
      <slot name="actions" />
    </div>
  </section>
</template>
