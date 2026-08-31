export type VfsPerformanceStatus = 'ok' | 'error'

export interface VfsPerformanceMetric {
  operation: string
  durationMs: number
  status: VfsPerformanceStatus
  errorCode?: string
  root?: string
  route?: string
  toolName?: string
  pluginId?: string
  itemCount?: number
  byteCount?: number
  jobId?: string
  context?: Record<string, string | number | boolean | undefined>
  measuredAtMs: number
}

export interface VfsPerformanceProbe {
  record(metric: VfsPerformanceMetric): void
  measure<T>(
    input: Omit<VfsPerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    action: () => T
  ): T
  measureAsync<T>(
    input: Omit<VfsPerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    action: () => Promise<T>
  ): Promise<T>
  snapshot(): VfsPerformanceMetric[]
  reset(): void
}

export interface VfsPerformanceBudget {
  operation: string
  p95Ms: number
}

export interface VfsPerformanceBudgetResult {
  ok: boolean
  operation: string
  p95Ms: number
  budgetMs: number
  sampleCount: number
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function errorCodeFrom(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { code?: unknown } }).error
    return typeof error?.code === 'string' ? error.code : undefined
  }
  if (value instanceof Error) return value.name
  return undefined
}

function isErrorResult(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === false)
}

export function createVfsPerformanceProbe(clock: () => number = Date.now): VfsPerformanceProbe {
  const metrics: VfsPerformanceMetric[] = []

  function finish(
    input: Omit<VfsPerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    startedAt: number,
    value: unknown,
    thrown?: unknown
  ): void {
    const failed = thrown !== undefined || isErrorResult(value)
    metrics.push({
      ...input,
      durationMs: Math.max(0, nowMs() - startedAt),
      status: failed ? 'error' : 'ok',
      errorCode: input.errorCode || errorCodeFrom(thrown ?? value),
      measuredAtMs: clock()
    })
  }

  return {
    record(metric) {
      metrics.push({ ...metric })
    },
    measure(input, action) {
      const startedAt = nowMs()
      try {
        const value = action()
        finish(input, startedAt, value)
        return value
      } catch (error) {
        finish(input, startedAt, undefined, error)
        throw error
      }
    },
    async measureAsync(input, action) {
      const startedAt = nowMs()
      try {
        const value = await action()
        finish(input, startedAt, value)
        return value
      } catch (error) {
        finish(input, startedAt, undefined, error)
        throw error
      }
    },
    snapshot() {
      return metrics.map((metric) => ({ ...metric }))
    },
    reset() {
      metrics.length = 0
    }
  }
}

export function evaluateVfsPerformanceBudgets(
  metrics: VfsPerformanceMetric[],
  budgets: VfsPerformanceBudget[]
): VfsPerformanceBudgetResult[] {
  return budgets.map((budget) => {
    const samples = metrics
      .filter((metric) => metric.operation === budget.operation)
      .map((metric) => metric.durationMs)
      .sort((left, right) => left - right)
    const p95Index = samples.length ? Math.ceil(samples.length * 0.95) - 1 : 0
    const p95Ms = samples[p95Index] ?? 0
    return {
      ok: p95Ms <= budget.p95Ms,
      operation: budget.operation,
      p95Ms,
      budgetMs: budget.p95Ms,
      sampleCount: samples.length
    }
  })
}
