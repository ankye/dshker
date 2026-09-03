<script setup lang="ts">
import { computed, ref } from 'vue'
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
const activeUsageTab = ref<'overview' | 'statistics'>('overview')
const activeChart = ref<'daily' | 'model'>('daily')
const rangeStart = ref('')
const rangeEnd = ref('')

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

/** Daily rows are already cached by the main process; range selection never rereads session logs. */
const dailyRows = computed(() =>
  (usage.state.value?.dailyByModel ?? []).filter(
    (row) =>
      (rangeStart.value.length === 0 || row.date >= rangeStart.value) &&
      (rangeEnd.value.length === 0 || row.date <= rangeEnd.value)
  )
)

const dailyRowDays = computed(() => new Set(dailyRows.value.map((row) => row.date)).size)

/** One bar per recorded day; entries without timestamp never enter this visual aggregate. */
const dailyTotals = computed(() => {
  const totals = new Map<string, number>()
  for (const row of dailyRows.value) {
    const total = billedInputTokens(row) + row.outputTokens
    totals.set(row.date, (totals.get(row.date) ?? 0) + total)
  }
  return [...totals.entries()]
    .map(([date, total]) => ({ date, total }))
    .sort((left, right) => left.date.localeCompare(right.date))
})

/** Models remain in a stable order across dates, so colour and legend never drift while filtering. */
const modelSeries = computed(() => {
  const totals = new Map<string, number>()
  for (const row of dailyRows.value) {
    const total = billedInputTokens(row) + row.outputTokens
    totals.set(row.model, (totals.get(row.model) ?? 0) + total)
  }
  return [...totals.entries()]
    .map(([model, total]) => ({ model, total }))
    .sort((left, right) => right.total - left.total || left.model.localeCompare(right.model))
})

const dailyTotalMax = computed(() => Math.max(0, ...dailyTotals.value.map((entry) => entry.total)))

const dailyModelBars = computed(() => {
  const totalsByDay = new Map<string, Map<string, number>>()
  for (const day of dailyTotals.value) {
    totalsByDay.set(day.date, new Map())
  }
  for (const row of dailyRows.value) {
    const values = totalsByDay.get(row.date)
    if (values === undefined) continue
    values.set(row.model, billedInputTokens(row) + row.outputTokens)
  }
  return dailyTotals.value.map((day) => ({
    date: day.date,
    bars: modelSeries.value.map((series, index) => ({
      model: series.model,
      total: totalsByDay.get(day.date)?.get(series.model) ?? 0,
      index
    }))
  }))
})

const dailyModelMax = computed(() =>
  Math.max(0, ...dailyModelBars.value.flatMap((day) => day.bars.map((bar) => bar.total)))
)

function toLocalDateInput(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function selectRecentRange(days: number): void {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - days + 1)
  rangeStart.value = toLocalDateInput(start)
  rangeEnd.value = toLocalDateInput(end)
}

function clearRange(): void {
  rangeStart.value = ''
  rangeEnd.value = ''
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString()
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(value < 10 ? 1 : 0)}%`
}

function displayModel(model: string): string {
  return model === 'unknown' ? t('usage.unknownModel') : model
}

function chartHeight(value: number, maximum: number): string {
  if (value === 0 || maximum === 0) return '0%'
  return `${Math.max(4, (value / maximum) * 100)}%`
}
</script>

<template>
  <section class="usage-panel">
    <header class="usage-header">
      <!-- The route title and description are carried by RouteStage. -->
      <p class="usage-source">{{ t('usage.source') }}</p>
      <button
        class="usage-refresh-button"
        type="button"
        :disabled="usage.loading.value"
        data-testid="refresh-usage"
        @click="usage.refresh"
      >
        <svg
          class="usage-refresh-icon"
          :data-loading="usage.loading.value"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path d="M20 11a8 8 0 1 0 2.1 5.4" />
          <path d="M20 4v7h-7" />
        </svg>
        {{ usage.loading.value ? t('usage.refreshing') : t('usage.refresh') }}
      </button>
    </header>

    <p v-if="usage.error.value" class="usage-error" role="alert">
      {{ t('usage.error') }} <code>{{ usage.error.value }}</code>
    </p>

    <div class="usage-tabs" role="tablist" :aria-label="t('usage.title')">
      <button
        type="button"
        role="tab"
        :aria-selected="activeUsageTab === 'overview'"
        :data-active="activeUsageTab === 'overview'"
        @click="activeUsageTab = 'overview'"
      >
        {{ t('usage.tab.overview') }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeUsageTab === 'statistics'"
        :data-active="activeUsageTab === 'statistics'"
        @click="activeUsageTab = 'statistics'"
      >
        {{ t('usage.tab.statistics') }}
      </button>
    </div>

    <template v-if="summary && activeUsageTab === 'overview'">
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

    <section
      v-else-if="activeUsageTab === 'statistics' && usage.state.value"
      class="usage-statistics"
      role="tabpanel"
    >
      <header class="usage-statistics-header">
        <div>
          <h3>{{ t('usage.statistics.title') }}</h3>
          <p>{{ t('usage.statistics.description') }}</p>
        </div>
        <p class="usage-statistics-count">
          {{ t('usage.statistics.showing') }} {{ dailyRowDays }} {{ t('usage.statistics.days') }} ·
          {{ dailyRows.length }} {{ t('usage.statistics.rows') }}
        </p>
      </header>
      <div class="usage-range-controls">
        <label>
          <span>{{ t('usage.range.from') }}</span>
          <input v-model="rangeStart" type="date" :max="rangeEnd || undefined" />
        </label>
        <span class="usage-range-separator" aria-hidden="true">—</span>
        <label>
          <span>{{ t('usage.range.to') }}</span>
          <input v-model="rangeEnd" type="date" :min="rangeStart || undefined" />
        </label>
        <div class="usage-range-presets" role="group" :aria-label="t('usage.statistics.title')">
          <button type="button" @click="selectRecentRange(7)">
            {{ t('usage.range.last7Days') }}
          </button>
          <button type="button" @click="selectRecentRange(30)">
            {{ t('usage.range.last30Days') }}
          </button>
          <button type="button" @click="clearRange">{{ t('usage.range.all') }}</button>
        </div>
      </div>
      <section v-if="dailyRows.length > 0" class="usage-chart-panel">
        <div class="usage-chart-header">
          <div class="usage-chart-toggle" role="tablist" :aria-label="t('usage.statistics.title')">
            <button
              type="button"
              role="tab"
              :aria-selected="activeChart === 'daily'"
              :data-active="activeChart === 'daily'"
              @click="activeChart = 'daily'"
            >
              {{ t('usage.chart.dailyTotal') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="activeChart === 'model'"
              :data-active="activeChart === 'model'"
              @click="activeChart = 'model'"
            >
              {{ t('usage.chart.byModel') }}
            </button>
          </div>
          <p>
            {{
              activeChart === 'daily'
                ? t('usage.chart.dailyTotalDescription')
                : t('usage.chart.byModelDescription')
            }}
          </p>
        </div>
        <div
          v-if="activeChart === 'daily'"
          class="usage-bar-chart usage-bar-chart--daily"
          role="img"
          :aria-label="t('usage.chart.dailyTotalLabel')"
          :style="{ '--usage-chart-columns': dailyTotals.length }"
        >
          <div v-for="day in dailyTotals" :key="day.date" class="usage-chart-day">
            <span class="usage-chart-value">{{ formatTokens(day.total) }}</span>
            <div class="usage-chart-plot">
              <span
                class="usage-chart-bar"
                :style="{ height: chartHeight(day.total, dailyTotalMax) }"
              />
            </div>
            <span class="usage-chart-label">{{ day.date.slice(5) }}</span>
          </div>
        </div>
        <template v-else>
          <ul class="usage-chart-legend" :aria-label="t('usage.chart.modelLegend')">
            <li v-for="(series, index) in modelSeries" :key="series.model">
              <span class="usage-chart-swatch" :data-series="index % 6" aria-hidden="true" />
              <span>{{ displayModel(series.model) }}</span>
            </li>
          </ul>
          <div
            class="usage-bar-chart usage-bar-chart--model"
            role="img"
            :aria-label="t('usage.chart.byModelLabel')"
            :style="{ '--usage-chart-columns': dailyModelBars.length }"
          >
            <div
              v-for="day in dailyModelBars"
              :key="day.date"
              class="usage-chart-day usage-chart-day--model"
            >
              <div class="usage-chart-plot usage-chart-plot--grouped">
                <span
                  v-for="bar in day.bars"
                  :key="bar.model"
                  class="usage-chart-bar"
                  :data-series="bar.index % 6"
                  :style="{ height: chartHeight(bar.total, dailyModelMax) }"
                  :title="`${displayModel(bar.model)} · ${formatTokens(bar.total)}`"
                />
              </div>
              <span class="usage-chart-label">{{ day.date.slice(5) }}</span>
            </div>
          </div>
        </template>
      </section>
      <table v-if="dailyRows.length > 0" class="usage-table usage-statistics-table">
        <thead>
          <tr>
            <th scope="col">{{ t('usage.columnDate') }}</th>
            <th scope="col">{{ t('usage.columnModel') }}</th>
            <th scope="col" class="usage-numeric">{{ t('usage.columnInput') }}</th>
            <th scope="col" class="usage-numeric">{{ t('usage.columnOutput') }}</th>
            <th scope="col" class="usage-numeric">{{ t('usage.columnTotal') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in dailyRows" :key="`${row.date}-${row.model}`">
            <td class="usage-date-cell">{{ row.date }}</td>
            <td>{{ displayModel(row.model) }}</td>
            <td class="usage-numeric">{{ formatTokens(billedInputTokens(row)) }}</td>
            <td class="usage-numeric">{{ formatTokens(row.outputTokens) }}</td>
            <td class="usage-numeric usage-total-cell">
              {{ formatTokens(billedInputTokens(row) + row.outputTokens) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="usage-range-empty">{{ t('usage.statistics.empty') }}</p>
    </section>

    <EmptyState
      v-else-if="!usage.loading.value && activeUsageTab === 'overview'"
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

.usage-refresh-button {
  display: inline-flex;
  min-height: var(--size-control-sm);
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
  cursor: pointer;
  font-size: var(--type-caption);
  font-weight: var(--font-weight-medium);
}

.usage-refresh-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-accent), var(--color-border) 45%);
  background: color-mix(in srgb, var(--color-accent), var(--color-surface-muted) 92%);
}

.usage-refresh-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.usage-refresh-icon {
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.usage-refresh-icon[data-loading='true'] {
  animation: usage-refresh-spin 0.9s linear infinite;
}

.usage-tabs {
  display: flex;
  align-self: stretch;
  gap: var(--space-1);
  border-bottom: 1px solid var(--color-border);
}

.usage-tabs button {
  position: relative;
  min-height: var(--size-control-sm);
  padding: 0 var(--space-3);
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-caption);
  font-weight: var(--font-weight-medium);
}

.usage-tabs button[data-active='true'] {
  color: var(--color-text);
}

.usage-tabs button[data-active='true']::after {
  position: absolute;
  right: var(--space-3);
  bottom: -1px;
  left: var(--space-3);
  height: 2px;
  border-radius: 999px;
  background: var(--color-accent);
  content: '';
}

.usage-tabs button:focus-visible,
.usage-refresh-button:focus-visible,
.usage-range-controls input:focus-visible,
.usage-range-presets button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
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

.usage-statistics {
  display: grid;
  gap: var(--space-4);
}

.usage-statistics-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
}

.usage-statistics-header h3,
.usage-statistics-header p {
  margin: 0;
}

.usage-statistics-header h3 {
  color: var(--color-text);
  font-size: var(--type-ui);
}

.usage-statistics-header p {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-statistics-count {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.usage-range-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.usage-range-controls label {
  display: grid;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-range-controls input {
  min-height: var(--size-control-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
  font: inherit;
}

.usage-range-separator {
  min-height: var(--size-control-sm);
  padding-bottom: 0.1rem;
  color: var(--color-text-muted);
}

.usage-range-presets {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: var(--space-2);
}

.usage-range-presets button {
  min-height: var(--size-control-sm);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-caption);
}

.usage-range-presets button:hover {
  border-color: var(--color-border);
  color: var(--color-text);
}

.usage-statistics-table {
  border-top: 1px solid var(--color-border);
}

.usage-date-cell,
.usage-total-cell {
  font-variant-numeric: tabular-nums;
}

.usage-total-cell {
  color: var(--color-text);
  font-weight: var(--font-weight-medium);
}

.usage-range-empty {
  margin: 0;
  padding: var(--space-5) 0;
  color: var(--color-text-muted);
  text-align: center;
}

.usage-chart-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface-muted);
}

.usage-chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.usage-chart-header p {
  max-width: 28rem;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  text-align: right;
}

.usage-chart-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 0.125rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

.usage-chart-toggle button {
  min-height: calc(var(--size-control-sm) - 0.25rem);
  padding: 0 var(--space-3);
  border: 0;
  border-radius: calc(var(--radius-sm) - 0.125rem);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-caption);
}

.usage-chart-toggle button[data-active='true'] {
  background: color-mix(in srgb, var(--color-accent), transparent 84%);
  color: var(--color-text);
  font-weight: var(--font-weight-medium);
}

.usage-chart-toggle button:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}

.usage-bar-chart {
  display: grid;
  min-height: 12rem;
  align-items: end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
  overflow-x: auto;
}

.usage-bar-chart--daily {
  grid-template-columns: repeat(var(--usage-chart-columns), minmax(2.8rem, 1fr));
}

.usage-bar-chart--model {
  grid-template-columns: repeat(var(--usage-chart-columns), minmax(3.5rem, 1fr));
}

.usage-chart-day {
  display: grid;
  min-width: 0;
  grid-template-rows: auto minmax(8rem, 1fr) auto;
  gap: var(--space-1);
  align-items: end;
}

.usage-chart-value,
.usage-chart-label {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  font-variant-numeric: tabular-nums;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-chart-value {
  color: var(--color-text);
  font-weight: var(--font-weight-medium);
}

.usage-chart-plot {
  display: flex;
  height: 8rem;
  align-items: end;
  justify-content: center;
  gap: 0.2rem;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border), transparent 30%);
}

.usage-chart-day--model {
  grid-template-rows: minmax(8rem, 1fr) auto;
}

.usage-chart-bar {
  display: block;
  min-width: 0.45rem;
  flex: 1 1 0;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background: var(--color-accent);
}

.usage-chart-bar[data-series='1'],
.usage-chart-swatch[data-series='1'] {
  background: var(--color-success);
}

.usage-chart-bar[data-series='2'],
.usage-chart-swatch[data-series='2'] {
  background: var(--color-warning);
}

.usage-chart-bar[data-series='3'],
.usage-chart-swatch[data-series='3'] {
  background: var(--color-focus);
}

.usage-chart-bar[data-series='4'],
.usage-chart-swatch[data-series='4'] {
  background: color-mix(in srgb, var(--color-accent), var(--color-text) 38%);
}

.usage-chart-bar[data-series='5'],
.usage-chart-swatch[data-series='5'] {
  background: color-mix(in srgb, var(--color-success), var(--color-text) 38%);
}

.usage-chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.usage-chart-legend li {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.usage-chart-swatch {
  display: block;
  width: 0.625rem;
  height: 0.625rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--color-accent);
}

@media (max-width: 48rem) {
  .usage-chart-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .usage-chart-header p {
    max-width: none;
    text-align: left;
  }
}

@keyframes usage-refresh-spin {
  to {
    transform: rotate(360deg);
  }
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
