import { computed, onMounted, ref } from 'vue'
import type { TokenUsageState } from '@/shared/contracts'

const state = ref<TokenUsageState>()
const loading = ref(false)
const error = ref<string>()

/** Prompt-side billing is the sum of the three disjoint input buckets. */
export function billedInputTokens(usage: {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * Cache-hit share of prompt-side input, or undefined when nothing was billed.
 *
 * Mirrors DSH's own reporting: the denominator is billed input, not raw request
 * volume, so the figure matches what the DSH web stats line shows.
 */
export function cacheHitPercent(usage: {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}): number | undefined {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return undefined
  return (100 * usage.cacheReadTokens) / denominator
}

/** Compact token count: 1.2M, 24.6K, or an exact figure below a thousand. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

async function refresh(): Promise<void> {
  if (!window.dshLauncher || loading.value) return
  loading.value = true
  try {
    const result = await window.dshLauncher.tokenUsage.getState()
    if (!result.ok) {
      error.value = result.code
      return
    }
    state.value = result.data
    error.value = undefined
  } finally {
    loading.value = false
  }
}

/** Read-only renderer view of the token usage DSH recorded in its session logs. */
export function useTokenUsage() {
  onMounted(() => {
    void refresh()
  })
  const sessions = computed(() => state.value?.sessions ?? [])
  const totals = computed(() => state.value?.totals)
  return {
    state,
    loading,
    error,
    sessions,
    totals,
    refresh
  }
}
