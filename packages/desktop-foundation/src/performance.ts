import type { ApiResult } from './contracts'
import { redactSecrets } from './logger'

export type PerformanceMetricCategory =
  | 'startup'
  | 'renderer'
  | 'bridge'
  | 'vfs'
  | 'resource-import'
  | 'memory'
  | 'long-task'
  | 'release'
  | (string & {})

export type PerformanceMetricStatus = 'ok' | 'error'

export interface PerformanceMetric {
  name: string
  category: PerformanceMetricCategory
  durationMs?: number
  value?: number
  unit?: 'ms' | 'bytes' | 'count' | 'mb'
  status: PerformanceMetricStatus
  errorCode?: string
  measuredAtMs: number
  context?: Record<string, string | number | boolean | undefined>
}

export interface PerformanceBudget {
  name: string
  maxDurationMs?: number
  maxValue?: number
  unit?: PerformanceMetric['unit']
}

export interface PerformanceBudgetResult {
  ok: boolean
  name: string
  measured: number
  budget: number
  unit: PerformanceMetric['unit']
  sampleCount: number
}

export interface BenchmarkEnvironment {
  platform: string
  architecture: string
  nodeVersion: string
  userAgent: string
  measuredAtMs: number
}

export interface PerformanceProbe {
  record(metric: Omit<PerformanceMetric, 'measuredAtMs'> & { measuredAtMs?: number }): void
  measure<T>(
    input: Omit<PerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    action: () => T
  ): T
  measureAsync<T>(
    input: Omit<PerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    action: () => Promise<T>
  ): Promise<T>
  memory(name?: string): PerformanceMetric
  snapshot(): PerformanceMetric[]
  reset(): void
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function statusFrom(value: unknown, thrown?: unknown): PerformanceMetricStatus {
  if (thrown !== undefined) return 'error'
  if (value && typeof value === 'object' && 'ok' in value && value.ok === false) return 'error'
  return 'ok'
}

function errorCodeFrom(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { code?: unknown } }).error
    return typeof error?.code === 'string' ? error.code : undefined
  }
  if (value instanceof Error) return value.name
  return undefined
}

function sanitizeContext(
  context: PerformanceMetric['context']
): PerformanceMetric['context'] | undefined {
  if (!context) return undefined
  return redactSecrets(context) as PerformanceMetric['context']
}

function memoryUsedBytes(): number {
  const processLike = globalThis as typeof globalThis & {
    process?: { memoryUsage?: () => { heapUsed?: number } }
  }
  const heapUsed = processLike.process?.memoryUsage?.().heapUsed
  return typeof heapUsed === 'number' ? heapUsed : 0
}

export function createPerformanceProbe(clock: () => number = Date.now): PerformanceProbe {
  const metrics: PerformanceMetric[] = []

  function push(metric: Omit<PerformanceMetric, 'measuredAtMs'> & { measuredAtMs?: number }): void {
    metrics.push({
      ...metric,
      measuredAtMs: metric.measuredAtMs ?? clock(),
      context: sanitizeContext(metric.context)
    })
  }

  function finish(
    input: Omit<PerformanceMetric, 'durationMs' | 'status' | 'measuredAtMs'>,
    startedAtMs: number,
    value: unknown,
    thrown?: unknown
  ): void {
    push({
      ...input,
      durationMs: Math.max(0, monotonicNow() - startedAtMs),
      status: statusFrom(value, thrown),
      errorCode: input.errorCode || errorCodeFrom(thrown ?? value)
    })
  }

  return {
    record: push,
    measure(input, action) {
      const startedAtMs = monotonicNow()
      try {
        const value = action()
        finish(input, startedAtMs, value)
        return value
      } catch (error) {
        finish(input, startedAtMs, undefined, error)
        throw error
      }
    },
    async measureAsync(input, action) {
      const startedAtMs = monotonicNow()
      try {
        const value = await action()
        finish(input, startedAtMs, value)
        return value
      } catch (error) {
        finish(input, startedAtMs, undefined, error)
        throw error
      }
    },
    memory(name = 'memory.heap_used') {
      const metric: PerformanceMetric = {
        name,
        category: 'memory',
        value: memoryUsedBytes(),
        unit: 'bytes',
        status: 'ok',
        measuredAtMs: clock()
      }
      metrics.push(metric)
      return { ...metric }
    },
    snapshot() {
      return metrics.map((metric) => ({
        ...metric,
        context: metric.context ? { ...metric.context } : undefined
      }))
    },
    reset() {
      metrics.length = 0
    }
  }
}

export function evaluatePerformanceBudgets(
  metrics: PerformanceMetric[],
  budgets: PerformanceBudget[]
): PerformanceBudgetResult[] {
  return budgets.map((budget) => {
    const samples = metrics
      .filter((metric) => metric.name === budget.name)
      .map((metric) =>
        budget.maxDurationMs !== undefined ? (metric.durationMs ?? 0) : (metric.value ?? 0)
      )
      .sort((left, right) => left - right)
    const index = samples.length ? Math.ceil(samples.length * 0.95) - 1 : 0
    const measured = samples[index] ?? 0
    const threshold = budget.maxDurationMs ?? budget.maxValue ?? 0

    return {
      ok: measured <= threshold,
      name: budget.name,
      measured,
      budget: threshold,
      unit: budget.unit || (budget.maxDurationMs !== undefined ? 'ms' : undefined),
      sampleCount: samples.length
    }
  })
}

export function getBenchmarkEnvironment(clock: () => number = Date.now): BenchmarkEnvironment {
  const processLike = globalThis as typeof globalThis & {
    process?: { platform?: string; arch?: string; version?: string }
    navigator?: { userAgent?: string }
  }

  return {
    platform: processLike.process?.platform || 'browser',
    architecture: processLike.process?.arch || '',
    nodeVersion: processLike.process?.version || '',
    userAgent: processLike.navigator?.userAgent || '',
    measuredAtMs: clock()
  }
}

export function isErrorResult<T>(result: ApiResult<T>): boolean {
  return !result.ok
}
