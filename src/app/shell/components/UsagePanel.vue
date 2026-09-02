<script setup lang="ts">
import { computed } from 'vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import {
  billedInputTokens,
  cacheHitPercent,
  formatTokens,
  useTokenUsage
} from '@/app/domains/token-usage'

import EmptyState from './EmptyState.vue'

const t = useTranslator()
const usage = useTokenUsage()

/** Whole-scope figures, shown as the headline summary. */
const summary = computed(() => {
  const totals = usage.totals.value
  if (!totals) return undefined
  const input = billedInputTokens(totals)
  if (input === 0 && totals.outputTokens === 0) return undefined
  return {
    input,
    output: totals.outputTokens,
    cacheHit: cacheHitPercent(totals),
    sessions: usage.state.value?.totalSessions ?? usage.sessions.value.length
  }
})

/**
 * Cache hit rate is the one summary figure that is good or bad rather than just
 * large, so it earns a colour. Thresholds are deliberately wide: this flags an
 * obviously unhealthy rate, it does not grade a healthy one. Undefined stays
 * neutral so "no data" never reads as a problem.
 */
const cacheHitHealth = computed<'good' | 'poor' | undefined>(() => {
  const rate = summary.value?.cacheHit
  if (rate === undefined) return undefined
  if (rate >= 50) return 'good'
  if (rate < 20) return 'poor'
  return undefined
})

/** Sessions that actually billed tokens, newest first. */
const billedSessions = computed(() =>
  usage.sessions.value.filter(
    (session) => billedInputTokens(session) > 0 || session.outputTokens > 0
  )
)

/** How many readable sessions the detail list is not showing. */
const omittedSessions = computed(() => {
  const total = usage.state.value?.totalSessions ?? 0
  return Math.max(0, total - usage.sessions.value.length)
})

function formatDate(value: number): string {
  return new Date(value).toLocaleString()
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`
}
</script>

<template>
  <section class="usage-panel">
    <header class="usage-header">
      <!-- The route title and description are carried by RouteStage. -->
      <p class="usage-source">{{ t('usage.source') }}</p>
      <button
        class="managed-secondary-action"
        type="button"
        :disabled="usage.loading.value"
        data-testid="refresh-usage"
        @click="usage.refresh"
      >
        {{ t('usage.refresh') }}
      </button>
    </header>

    <p v-if="usage.error.value" class="usage-error" role="alert">
      {{ t('usage.error') }} <code>{{ usage.error.value }}</code>
    </p>

    <template v-if="summary">
      <!--
        Input is the cost driver, so it leads; cache hit carries a health tone
        because it is the one number here that is good or bad rather than
        merely large. The rest are context and stay quiet.
      -->
      <!--
        A description list, so each label genuinely associates with its value.
        `dt`/`dd` previously sat inside `article`, which is invalid HTML and left
        the pairing to visual proximity alone.
      -->
      <dl class="usage-summary" :aria-label="t('usage.summaryLabel')">
        <div class="usage-metric" data-emphasis="primary">
          <dt>{{ t('usage.inputTokens') }}</dt>
          <dd>{{ formatTokens(summary.input) }}</dd>
        </div>
        <div class="usage-metric">
          <dt>{{ t('usage.outputTokens') }}</dt>
          <dd>{{ formatTokens(summary.output) }}</dd>
        </div>
        <div class="usage-metric">
          <dt>{{ t('usage.cacheHit') }}</dt>
          <dd :data-health="cacheHitHealth">{{ formatPercent(summary.cacheHit) }}</dd>
        </div>
        <div class="usage-metric">
          <dt>{{ t('usage.sessions') }}</dt>
          <dd>{{ summary.sessions }}</dd>
        </div>
      </dl>

      <p class="usage-note">{{ t('usage.billingNote') }}</p>

      <section class="usage-sessions" aria-labelledby="usage-sessions-heading">
        <h3 id="usage-sessions-heading">{{ t('usage.sessionsTitle') }}</h3>
        <p v-if="omittedSessions > 0" class="usage-note">
          {{ t('usage.showingRecent') }} {{ billedSessions.length }} / {{ summary.sessions }}
        </p>
        <table class="usage-table">
          <thead>
            <tr>
              <th scope="col">{{ t('usage.columnSession') }}</th>
              <th scope="col">{{ t('usage.columnModel') }}</th>
              <th scope="col" class="usage-numeric">{{ t('usage.columnTurns') }}</th>
              <th scope="col" class="usage-numeric">{{ t('usage.columnInput') }}</th>
              <th scope="col" class="usage-numeric">{{ t('usage.columnOutput') }}</th>
              <th scope="col">{{ t('usage.columnUpdated') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in billedSessions" :key="session.sessionId">
              <td>
                <span class="usage-prompt">{{ session.firstPrompt ?? session.sessionId }}</span>
                <code class="usage-project">{{ session.project }}</code>
              </td>
              <td>{{ session.model ?? '—' }}</td>
              <td class="usage-numeric">{{ session.turns }}</td>
              <td class="usage-numeric">{{ formatTokens(billedInputTokens(session)) }}</td>
              <td class="usage-numeric">{{ formatTokens(session.outputTokens) }}</td>
              <td>{{ formatDate(session.updatedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <EmptyState
      v-else-if="!usage.loading.value"
      icon="chart"
      :title="t('usage.empty')"
      :description="t('usage.empty.description')"
    />

    <p v-if="usage.state.value && usage.state.value.unreadableSessions > 0" class="usage-note">
      {{ t('usage.unreadable') }} {{ usage.state.value.unreadableSessions }}
    </p>
  </section>
</template>

<style scoped>
.usage-panel {
  display: grid;
  align-content: start;
  gap: var(--space-5);
  padding: var(--space-5);
}

.usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.usage-source {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-summary {
  display: grid;
  margin: 0;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
}

.usage-metric {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
}

.usage-summary dt {
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-summary dd {
  margin: 0;
  color: var(--color-text);
  font-size: var(--type-section);
  font-variant-numeric: tabular-nums;
}

/* The cost driver reads first; the others stay reference values. */
.usage-metric[data-emphasis='primary'] {
  border-color: color-mix(in srgb, var(--color-accent), transparent 55%);
}

.usage-metric[data-emphasis='primary'] dd {
  font-size: var(--type-title);
  font-weight: var(--font-weight-medium);
}

/* Health encoding, not decoration: a low cache hit rate costs real money. */
.usage-summary dd[data-health='good'] {
  color: var(--color-success);
}

.usage-summary dd[data-health='poor'] {
  color: var(--color-warning);
}

.usage-sessions h3 {
  margin: 0 0 var(--space-3);
  color: var(--color-text);
  font-size: var(--type-ui);
}

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--type-caption);
}

.usage-table th,
.usage-table td {
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

.usage-table th {
  color: var(--color-text-muted);
  font-weight: var(--font-weight-medium);
}

.usage-table td {
  color: var(--color-text);
}

.usage-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage-prompt {
  display: block;
  overflow: hidden;
  max-width: 22rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-project {
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-note,
.usage-error {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-error {
  color: var(--color-danger);
}
</style>
