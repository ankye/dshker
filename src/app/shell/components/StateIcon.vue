<script setup lang="ts">
/**
 * Glyphs for non-populated surfaces. These are deliberately separate from
 * `RouteIcon`: navigation icons are a closed set tied to routes, while these
 * describe a *condition* (nothing here, blocked, working) and are reused across
 * unrelated routes.
 */
export type StateIconId = 'inbox' | 'alert' | 'spinner' | 'plug' | 'chart' | 'window'

defineProps<{
  readonly icon: StateIconId
}>()
</script>

<template>
  <svg
    class="state-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="icon === 'inbox'">
      <path d="M3 13h4l1.5 2.5h7L17 13h4" />
      <path d="M4.5 5.5h15l1.5 7.5v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z" />
    </template>

    <template v-else-if="icon === 'alert'">
      <path d="M12 4.5 21 19.5H3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="16.8" x2="12" y2="16.9" />
    </template>

    <template v-else-if="icon === 'spinner'">
      <!-- Rotation lives in CSS so `prefers-reduced-motion` can stop it. -->
      <circle class="state-icon-track" cx="12" cy="12" r="8" />
      <path class="state-icon-arc" d="M20 12a8 8 0 0 0-8-8" />
    </template>

    <template v-else-if="icon === 'plug'">
      <path d="M9 3v6" />
      <path d="M15 3v6" />
      <path d="M6 9h12v2a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
      <path d="M12 17v4" />
    </template>

    <template v-else-if="icon === 'chart'">
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="12" width="3" height="5" />
      <rect x="11" y="8" width="3" height="9" />
      <rect x="16" y="4" width="3" height="13" />
    </template>

    <template v-else-if="icon === 'window'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <circle cx="6.5" cy="6.5" r="0.6" />
    </template>
  </svg>
</template>
