<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'

/**
 * Registered paths and root IDs exist mainly to be pasted somewhere else, so
 * copying is the primary thing a user does with them. Selecting a long
 * monospace string by hand is the failure mode this replaces.
 */
const props = defineProps<{ readonly value: string }>()

const t = useTranslator()
const copied = ref(false)
let resetTimer: ReturnType<typeof setTimeout> | undefined

const CONFIRMATION_MILLISECONDS = 1_600

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    if (resetTimer !== undefined) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => {
      copied.value = false
    }, CONFIRMATION_MILLISECONDS)
  } catch {
    // A denied or unavailable clipboard is not worth interrupting the user for;
    // the path stays visible and selectable either way.
  }
}

onUnmounted(() => {
  if (resetTimer !== undefined) clearTimeout(resetTimer)
})
</script>

<template>
  <button
    type="button"
    class="copy-path-button"
    :data-copied="copied"
    :aria-label="t('common.copyPath')"
    :title="t('common.copyPath')"
    @click="copy"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="copied">
        <polyline points="5 13 10 18 19 7" />
      </template>
      <template v-else>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
      </template>
    </svg>
    <!-- Announced rather than shown: the icon already carries the state. -->
    <span class="copy-path-live" role="status">{{ copied ? t('common.copied') : '' }}</span>
  </button>
</template>

<style scoped>
.copy-path-button {
  display: inline-grid;
  width: var(--size-control-sm);
  height: var(--size-control-sm);
  flex: none;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.copy-path-button:hover {
  border-color: var(--color-border);
  background: var(--color-surface-muted);
  color: var(--color-text);
}

.copy-path-button[data-copied='true'] {
  color: var(--color-success);
}

.copy-path-button svg {
  width: 1rem;
  height: 1rem;
}

/* Visually hidden, still announced. */
.copy-path-live {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
