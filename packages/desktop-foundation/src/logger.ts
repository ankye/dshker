import type { DiagnosticEvent } from './contracts'
import { getDesktopApi } from './bridge'

const SECRET_KEYS = /(api[-_]?key|token|secret|password|credential|authorization)/i

export type DiagnosticArea =
  | 'startup'
  | 'config'
  | 'bridge'
  | 'vfs'
  | 'provider'
  | 'import'
  | 'build'
  | 'statlog'
  | 'runtime'
  | 'release'
  | (string & {})

export interface StructuredDiagnosticEvent extends DiagnosticEvent {
  code: string
  area: DiagnosticArea
  timestampMs: number
}

export interface DiagnosticsOptions {
  clock?: () => number
  sink?: (event: StructuredDiagnosticEvent) => void | Promise<void>
}

export interface DiagnosticsCollector {
  record(
    event: Omit<StructuredDiagnosticEvent, 'timestampMs'> & { timestampMs?: number }
  ): Promise<void>
  event(input: {
    area: DiagnosticArea
    code: string
    level?: DiagnosticEvent['level']
    message: string
    context?: Record<string, unknown>
  }): Promise<void>
  snapshot(): StructuredDiagnosticEvent[]
  clear(): void
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactSecrets(nested)
    }
    return output
  }

  if (typeof value === 'string' && value.length > 64 && /[A-Za-z0-9_-]{32,}/.test(value)) {
    return '[redacted]'
  }

  return value
}

export async function logEvent(event: DiagnosticEvent, api = getDesktopApi()): Promise<void> {
  const safeEvent: DiagnosticEvent = {
    ...event,
    context: event.context ? (redactSecrets(event.context) as Record<string, unknown>) : undefined
  }

  if (api?.diagnostics) {
    await api.diagnostics.log(safeEvent)
    return
  }

  const output = [safeEvent.message, safeEvent.context || {}] as const
  if (safeEvent.level === 'error') console.error(...output)
  else if (safeEvent.level === 'warn') console.warn(...output)
  else console.log(...output)
}

export function createDiagnostics(options: DiagnosticsOptions = {}): DiagnosticsCollector {
  const records: StructuredDiagnosticEvent[] = []
  const clock = options.clock || Date.now

  async function record(
    event: Omit<StructuredDiagnosticEvent, 'timestampMs'> & { timestampMs?: number }
  ): Promise<void> {
    const safeEvent: StructuredDiagnosticEvent = {
      ...event,
      timestampMs: event.timestampMs ?? clock(),
      context: event.context ? (redactSecrets(event.context) as Record<string, unknown>) : undefined
    }
    records.push(safeEvent)
    if (options.sink) await options.sink(safeEvent)
    else await logEvent(safeEvent)
  }

  return {
    record,
    event(input) {
      return record({
        level: input.level || 'info',
        area: input.area,
        code: input.code,
        message: input.message,
        context: input.context
      })
    },
    snapshot() {
      return records.map((event) => ({
        ...event,
        context: event.context ? { ...event.context } : undefined
      }))
    },
    clear() {
      records.length = 0
    }
  }
}
