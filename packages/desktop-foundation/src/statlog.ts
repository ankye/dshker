import type { DesktopApi, DiagnosticEvent } from './contracts'
import { logEvent, redactSecrets } from './logger'
import { readStorage, removeStorage, writeStorage } from './storage'

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_QUEUE_LIMIT = 1000
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_MAX_RETRY_MS = 30000

export const STATLOG_SDK_NAME = 'statlog-desktop'
export const STATLOG_SDK_VERSION = '0.1.0'

type StatLogPrimitive = string | number | boolean | bigint | Date
export type StatLogValue = StatLogPrimitive | null | undefined
export type StatLogProperties = Record<string, StatLogValue>

export interface StatLogKV {
  key: string
  value: string
}

export interface StatLogEventEnvelope {
  event_id: string
  project_id: number
  project_key: string
  app_id: string
  platform: string
  sdk_name: string
  sdk_version: string
  event_name: string
  event_time_ms: number
  uid: number
  device_id: string
  session_id: string
  scene: string
  scene_id: string
  trace_id: string
  request_id: string
  subject_ids: StatLogKV[]
  properties: StatLogKV[]
  context: StatLogKV[]
  reporter: string
  ingest_token: string
}

export interface StatLogIngestBatch {
  batch_id: string
  project_id: number
  project_key: string
  app_id: string
  source: string
  received_time_ms: number
  events: StatLogEventEnvelope[]
}

export interface StatLogCapabilities {
  code: number
  platforms: string[]
  batch: boolean
}

export interface StatLogTransportRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: unknown
  timeoutMs: number
}

export interface StatLogTransportResponse {
  ok: boolean
  status: number
  body?: unknown
}

export type StatLogTransport = (
  request: StatLogTransportRequest
) => Promise<StatLogTransportResponse>

export interface StatLogQueueStorage {
  load(): Promise<StatLogQueuedEvent[]>
  save(events: StatLogQueuedEvent[]): Promise<void>
  clear(): Promise<void>
}

export interface StatLogTrackOptions {
  eventId?: string
  projectId?: number
  projectKey?: string
  appId?: string
  platform?: string
  eventTimeMs?: number
  uid?: number
  deviceId?: string
  sessionId?: string
  scene?: string
  sceneId?: string
  traceId?: string
  requestId?: string
  subjectIds?: StatLogProperties
  context?: StatLogProperties
}

export interface StatLogClientOptions {
  endpoint: string
  capabilitiesEndpoint?: string
  projectId?: number
  projectKey?: string
  appId: string
  ingestToken?: string
  platform?: string
  reporter?: string
  batchSize?: number
  queueLimit?: number
  flushIntervalMs?: number
  timeoutMs?: number
  retryBaseMs?: number
  maxRetryMs?: number
  telemetryEnabled?: boolean
  optOut?: boolean
  uid?: number
  deviceId?: string
  sessionId?: string
  subjectIds?: StatLogProperties
  context?: StatLogProperties
  transport?: StatLogTransport
  storage?: StatLogQueueStorage
  diagnostics?: (event: DiagnosticEvent) => void | Promise<void>
  clock?: () => number
  idGenerator?: (prefix: string) => string
}

export interface StatLogQueueStatus {
  queued: number
  queueLimit: number
  dropped: number
  pendingRetry: boolean
  nextRetryAtMs: number
  lastErrorCode: string
}

export interface StatLogFlushSuccess {
  ok: true
  accepted: number
  rejected: number
  status: number
}

export interface StatLogFlushFailure {
  ok: false
  accepted: 0
  rejected: 0
  status: number
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type StatLogFlushResult = StatLogFlushSuccess | StatLogFlushFailure

export type StatLogCapabilityResult =
  | { ok: true; data: StatLogCapabilities; status: number }
  | {
      ok: false
      status: number
      error: { code: string; message: string; details?: unknown }
    }

export type StatLogQueuedEvent = Omit<StatLogEventEnvelope, 'ingest_token'>

export type StatLogEnvironmentName = 'local' | 'development' | 'staging' | 'production' | string

export interface StatLogConfigValues {
  endpoint?: string
  capabilitiesEndpoint?: string
  projectId?: number
  projectKey?: string
  appId?: string
  ingestToken?: string
  platform?: string
  reporter?: string
  batchSize?: number
  queueLimit?: number
  flushIntervalMs?: number
  timeoutMs?: number
  retryBaseMs?: number
  maxRetryMs?: number
  telemetryEnabled?: boolean
  optOut?: boolean
}

export interface StatLogConfigResolutionInput {
  environment: StatLogEnvironmentName
  appId: string
  defaults?: StatLogConfigValues
  environments?: Record<string, StatLogConfigValues>
  settings?: {
    telemetryEnabled?: boolean
  }
  launchArgs?: Record<string, string | number | boolean | undefined>
  secrets?: {
    ingestToken?: string
  }
  overrides?: StatLogConfigValues
}

export interface ResolvedStatLogConfig {
  options: StatLogClientOptions
  environment: StatLogEnvironmentName
  provenance: Record<string, string>
}

const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/

function nowMs(): number {
  return Date.now()
}

function randomPart(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID().split('-').join('')
  return Math.random().toString(36).slice(2)
}

function defaultId(prefix: string, clock: () => number = nowMs): string {
  return `${prefix}_${clock()}_${randomPart()}`
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function normalizeBoolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return undefined
}

function valueToString(value: StatLogPrimitive): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export function isSafeStatLogName(value: string): boolean {
  return EVENT_NAME_PATTERN.test(value)
}

export function isSafeStatLogKey(value: string): boolean {
  return KEY_PATTERN.test(value)
}

export function objectToStatLogKV(value: StatLogProperties | undefined): StatLogKV[] {
  if (!value) return []

  const output: StatLogKV[] = []
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null) continue
    if (!isSafeStatLogKey(key)) {
      throw new Error(`Unsafe StatLog key: ${key}`)
    }
    output.push({ key, value: valueToString(rawValue) })
  }
  return output
}

export function resolveStatLogCapabilitiesEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1/statlog/report')) {
    return `${trimmed.slice(0, -'/report'.length)}/capabilities`
  }
  return `${trimmed}/capabilities`
}

export function createFetchStatLogTransport(fetchImpl = globalThis.fetch): StatLogTransport {
  return async (request) => {
    if (!fetchImpl) throw new Error('Fetch implementation is missing')

    const abortController = new AbortController()
    const timeout = globalThis.setTimeout(() => abortController.abort(), request.timeoutMs)

    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        keepalive: request.method === 'POST',
        signal: abortController.signal
      })
      const contentType = response.headers.get('content-type') || ''
      const body = contentType.includes('application/json') ? await response.json() : undefined
      return { ok: response.ok, status: response.status, body }
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }
}

export function createBridgeStatLogTransport(api: DesktopApi | undefined): StatLogTransport {
  return async (request) => {
    if (!api?.statlog?.request) throw new Error('StatLog bridge transport is missing')

    const result = await api.statlog.request(request)
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`)
    }

    return result.data
  }
}

export function createBridgeStatLogQueueStorage(
  api: DesktopApi | undefined,
  namespace = 'statlog',
  key = 'queue'
): StatLogQueueStorage {
  return {
    load: () => readStorage<StatLogQueuedEvent[]>(namespace, key, [], api),
    save: (events) => writeStorage(namespace, key, events, api),
    clear: () => removeStorage(namespace, key, api)
  }
}

function launchArg(
  launchArgs: Record<string, string | number | boolean | undefined> | undefined,
  ...keys: string[]
): string | number | boolean | undefined {
  if (!launchArgs) return undefined
  for (const key of keys) {
    if (launchArgs[key] !== undefined) return launchArgs[key]
  }
  return undefined
}

function configFromLaunchArgs(
  launchArgs: StatLogConfigResolutionInput['launchArgs']
): StatLogConfigValues {
  return {
    endpoint: launchArg(launchArgs, 'statlogEndpoint', 'statlog-endpoint') as string | undefined,
    capabilitiesEndpoint: launchArg(
      launchArgs,
      'statlogCapabilitiesEndpoint',
      'statlog-capabilities-endpoint'
    ) as string | undefined,
    projectKey: launchArg(launchArgs, 'statlogProjectKey', 'statlog-project-key') as
      | string
      | undefined,
    appId: launchArg(launchArgs, 'statlogAppId', 'statlog-app-id') as string | undefined,
    ingestToken: launchArg(launchArgs, 'statlogIngestToken', 'statlog-ingest-token') as
      | string
      | undefined,
    platform: launchArg(launchArgs, 'statlogPlatform', 'statlog-platform') as string | undefined,
    reporter: launchArg(launchArgs, 'statlogReporter', 'statlog-reporter') as string | undefined,
    projectId: numberFromUnknown(launchArg(launchArgs, 'statlogProjectId', 'statlog-project-id')),
    batchSize: numberFromUnknown(launchArg(launchArgs, 'statlogBatchSize', 'statlog-batch-size')),
    queueLimit: numberFromUnknown(
      launchArg(launchArgs, 'statlogQueueLimit', 'statlog-queue-limit')
    ),
    flushIntervalMs: numberFromUnknown(
      launchArg(launchArgs, 'statlogFlushIntervalMs', 'statlog-flush-interval-ms')
    ),
    timeoutMs: numberFromUnknown(launchArg(launchArgs, 'statlogTimeoutMs', 'statlog-timeout-ms')),
    telemetryEnabled: booleanFromUnknown(
      launchArg(launchArgs, 'statlogTelemetryEnabled', 'statlog-telemetry-enabled')
    ),
    optOut: booleanFromUnknown(launchArg(launchArgs, 'statlogOptOut', 'statlog-opt-out'))
  }
}

function withoutUndefined(values: StatLogConfigValues | undefined): StatLogConfigValues {
  if (!values) return {}
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function markProvenance(
  provenance: Record<string, string>,
  source: string,
  values: StatLogConfigValues | undefined
): void {
  for (const key of Object.keys(withoutUndefined(values))) provenance[key] = source
}

export function resolveStatLogConfig(input: StatLogConfigResolutionInput): ResolvedStatLogConfig {
  const provenance: Record<string, string> = {}
  const environmentValues = input.environments?.[input.environment]
  const settingsValues =
    input.settings?.telemetryEnabled === undefined
      ? {}
      : { telemetryEnabled: input.settings.telemetryEnabled }
  const launchValues = configFromLaunchArgs(input.launchArgs)
  const secretValues =
    input.secrets?.ingestToken === undefined ? {} : { ingestToken: input.secrets.ingestToken }
  const layers: [string, StatLogConfigValues | undefined][] = [
    ['default', input.defaults],
    [`environment:${input.environment}`, environmentValues],
    ['setting', settingsValues],
    ['launch-arg', launchValues],
    ['secret', secretValues],
    ['override', input.overrides]
  ]
  const values: StatLogConfigValues = Object.assign(
    {},
    ...layers.map(([, layer]) => withoutUndefined(layer))
  )
  for (const [source, layer] of layers) markProvenance(provenance, source, layer)

  const appId = values.appId || input.appId
  if (!values.appId) provenance.appId = 'input:appId'

  const options: StatLogClientOptions = {
    endpoint: values.endpoint || '',
    capabilitiesEndpoint: values.capabilitiesEndpoint,
    projectId: values.projectId,
    projectKey: values.projectKey,
    appId,
    ingestToken: values.ingestToken,
    platform: values.platform,
    reporter: values.reporter,
    batchSize: values.batchSize,
    queueLimit: values.queueLimit,
    flushIntervalMs: values.flushIntervalMs,
    timeoutMs: values.timeoutMs,
    retryBaseMs: values.retryBaseMs,
    maxRetryMs: values.maxRetryMs,
    telemetryEnabled: values.telemetryEnabled,
    optOut: values.optOut
  }

  return {
    options,
    environment: input.environment,
    provenance
  }
}

export function createMemoryStatLogQueueStorage(
  initialEvents: StatLogQueuedEvent[] = []
): StatLogQueueStorage {
  let events = [...initialEvents]

  return {
    async load() {
      return [...events]
    },
    async save(nextEvents) {
      events = [...nextEvents]
    },
    async clear() {
      events = []
    }
  }
}

export class StatLogClient {
  private readonly endpoint: string
  private readonly capabilitiesEndpoint: string
  private readonly projectId: number
  private readonly projectKey: string
  private readonly appId: string
  private readonly ingestToken: string
  private readonly platform: string
  private readonly reporter: string
  private readonly batchSize: number
  private readonly queueLimit: number
  private readonly flushIntervalMs: number
  private readonly timeoutMs: number
  private readonly retryBaseMs: number
  private readonly maxRetryMs: number
  private readonly transport: StatLogTransport
  private readonly storage?: StatLogQueueStorage
  private readonly diagnostics: (event: DiagnosticEvent) => void | Promise<void>
  private readonly clock: () => number
  private readonly idGenerator: (prefix: string) => string

  private queue: StatLogQueuedEvent[] = []
  private context: StatLogProperties
  private subjectIds: StatLogProperties
  private uid: number
  private deviceId: string
  private sessionId: string
  private telemetryEnabled: boolean
  private optedOut: boolean
  private timer: ReturnType<typeof globalThis.setInterval> | undefined
  private dropped = 0
  private retryAttempt = 0
  private nextRetryAtMs = 0
  private lastErrorCode = ''

  constructor(options: StatLogClientOptions) {
    if (!options.appId) throw new Error('StatLog appId is required')

    this.endpoint = options.endpoint || ''
    this.capabilitiesEndpoint =
      options.capabilitiesEndpoint || resolveStatLogCapabilitiesEndpoint(options.endpoint || '')
    this.projectId = Number(options.projectId || 0)
    this.projectKey = options.projectKey || ''
    this.appId = options.appId
    this.ingestToken = options.ingestToken || ''
    this.platform = options.platform || 'desktop'
    this.reporter = options.reporter || 'desktop'
    this.batchSize = normalizePositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE)
    this.queueLimit = normalizePositiveInteger(options.queueLimit, DEFAULT_QUEUE_LIMIT)
    this.flushIntervalMs =
      options.flushIntervalMs === 0
        ? 0
        : normalizePositiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS)
    this.timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.retryBaseMs = normalizePositiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS)
    this.maxRetryMs = normalizePositiveInteger(options.maxRetryMs, DEFAULT_MAX_RETRY_MS)
    this.transport = options.transport || createFetchStatLogTransport()
    this.storage = options.storage
    this.diagnostics = options.diagnostics || ((event) => logEvent(event))
    this.clock = options.clock || nowMs
    this.idGenerator = options.idGenerator || ((prefix) => defaultId(prefix, this.clock))
    this.context = { ...(options.context || {}) }
    this.subjectIds = { ...(options.subjectIds || {}) }
    this.uid = Number(options.uid || 0)
    this.deviceId = options.deviceId || this.idGenerator('device')
    this.sessionId = options.sessionId || this.idGenerator('session')
    this.telemetryEnabled = normalizeBoolean(options.telemetryEnabled, false)
    this.optedOut = Boolean(options.optOut)
  }

  async setup(): Promise<this> {
    if (this.storage) {
      try {
        this.queue = this.clampQueue(await this.storage.load())
      } catch (error) {
        this.emitDiagnostic('warn', 'Unable to load StatLog queue.', {
          error: String(error)
        })
      }
    }

    if (!this.timer && this.flushIntervalMs > 0) {
      this.timer = globalThis.setInterval(() => {
        void this.flush({ automatic: true })
      }, this.flushIntervalMs)
    }
    return this
  }

  async shutdown(): Promise<StatLogFlushResult> {
    if (this.timer) {
      globalThis.clearInterval(this.timer)
      this.timer = undefined
    }
    return this.flush()
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.telemetryEnabled = enabled
    if (!enabled) void this.clearQueue()
  }

  setOptOut(enabled: boolean): void {
    this.optedOut = enabled
    if (enabled) void this.clearQueue()
  }

  setUser(uid: number, subjectIds: StatLogProperties = {}): void {
    this.uid = Number(uid || 0)
    this.setSubjectIds(subjectIds)
  }

  setSubjectIds(subjectIds: StatLogProperties = {}): void {
    this.subjectIds = { ...this.subjectIds, ...subjectIds }
  }

  setSession(sessionId?: string): void {
    this.sessionId = sessionId || this.idGenerator('session')
  }

  setContext(context: StatLogProperties = {}): void {
    this.context = { ...this.context, ...context }
  }

  getQueueStatus(): StatLogQueueStatus {
    return {
      queued: this.queue.length,
      queueLimit: this.queueLimit,
      dropped: this.dropped,
      pendingRetry: this.nextRetryAtMs > this.clock(),
      nextRetryAtMs: this.nextRetryAtMs,
      lastErrorCode: this.lastErrorCode
    }
  }

  track(
    eventName: string,
    properties: StatLogProperties = {},
    options: StatLogTrackOptions = {}
  ): boolean {
    if (!this.canCollect()) return false
    if (!isSafeStatLogName(eventName)) {
      this.emitDiagnostic('warn', 'Rejected unsafe StatLog event name.', {
        eventName
      })
      return false
    }

    try {
      const event: StatLogQueuedEvent = {
        event_id: options.eventId || this.idGenerator('evt'),
        project_id: Number(options.projectId ?? this.projectId),
        project_key: options.projectKey || this.projectKey,
        app_id: options.appId || this.appId,
        platform: options.platform || this.platform,
        sdk_name: STATLOG_SDK_NAME,
        sdk_version: STATLOG_SDK_VERSION,
        event_name: eventName,
        event_time_ms: Number(options.eventTimeMs || this.clock()),
        uid: Number(options.uid ?? this.uid),
        device_id: options.deviceId || this.deviceId,
        session_id: options.sessionId || this.sessionId,
        scene: options.scene || '',
        scene_id: options.sceneId || '',
        trace_id: options.traceId || '',
        request_id: options.requestId || '',
        subject_ids: objectToStatLogKV({
          ...this.subjectIds,
          ...(options.subjectIds || {})
        }),
        properties: objectToStatLogKV(properties),
        context: objectToStatLogKV({
          ...this.context,
          ...(options.context || {})
        }),
        reporter: this.reporter
      }
      this.queue.push(event)
      this.clampQueueInPlace()
      void this.persistQueue()
      if (this.queue.length >= this.batchSize) void this.flush({ automatic: true })
      return true
    } catch (error) {
      this.emitDiagnostic('warn', 'Rejected invalid StatLog payload.', {
        error: String(error)
      })
      return false
    }
  }

  buildBatch(
    events: StatLogQueuedEvent[] = this.queue.slice(0, this.batchSize)
  ): StatLogIngestBatch {
    return {
      batch_id: this.idGenerator('batch'),
      project_id: this.projectId,
      project_key: this.projectKey,
      app_id: this.appId,
      source: this.reporter,
      received_time_ms: this.clock(),
      events: events.map((event) => ({
        ...event,
        ingest_token: this.ingestToken
      }))
    }
  }

  async flush(options: { automatic?: boolean } = {}): Promise<StatLogFlushResult> {
    if (!this.canCollect()) {
      await this.clearQueue()
      return { ok: true, accepted: 0, rejected: 0, status: 0 }
    }

    if (this.queue.length === 0) {
      return { ok: true, accepted: 0, rejected: 0, status: 0 }
    }

    if (options.automatic && this.nextRetryAtMs > this.clock()) {
      return this.flushFailure(0, 'statlog.retry_backoff', 'StatLog retry backoff is active.')
    }

    if (!this.endpoint) {
      return this.flushFailure(0, 'statlog.endpoint_missing', 'StatLog endpoint is missing.')
    }

    const events = this.queue.slice(0, this.batchSize)
    const batch = this.buildBatch(events)

    try {
      const response = await this.transport({
        method: 'POST',
        url: this.endpoint,
        headers: { 'content-type': 'application/json' },
        body: batch,
        timeoutMs: this.timeoutMs
      })

      if (!response.ok) {
        const code = response.status === 429 ? 'statlog.backpressure' : 'statlog.flush_failed'
        this.scheduleRetry(code)
        await this.persistQueue()
        return this.flushFailure(response.status, code, `StatLog flush failed: ${response.status}`)
      }

      this.queue.splice(0, events.length)
      this.retryAttempt = 0
      this.nextRetryAtMs = 0
      this.lastErrorCode = ''
      await this.persistQueue()

      const body = response.body as { accepted?: number; rejected?: number } | undefined
      return {
        ok: true,
        accepted: Number(body?.accepted ?? events.length),
        rejected: Number(body?.rejected ?? 0),
        status: response.status
      }
    } catch (error) {
      this.scheduleRetry('statlog.transport_failed')
      await this.persistQueue()
      return this.flushFailure(
        0,
        'statlog.transport_failed',
        'StatLog transport failed.',
        String(error)
      )
    }
  }

  async checkCapabilities(): Promise<StatLogCapabilityResult> {
    if (!this.capabilitiesEndpoint) {
      return {
        ok: false,
        status: 0,
        error: {
          code: 'statlog.capabilities_endpoint_missing',
          message: 'Capabilities endpoint is missing.'
        }
      }
    }

    try {
      const response = await this.transport({
        method: 'GET',
        url: this.capabilitiesEndpoint,
        headers: { accept: 'application/json' },
        timeoutMs: this.timeoutMs
      })

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: {
            code: 'statlog.capabilities_failed',
            message: `StatLog capabilities failed: ${response.status}`
          }
        }
      }

      const capabilities = response.body as Partial<StatLogCapabilities>
      return {
        ok: true,
        status: response.status,
        data: {
          code: Number(capabilities.code ?? 0),
          platforms: Array.isArray(capabilities.platforms)
            ? capabilities.platforms.map(String)
            : [],
          batch: Boolean(capabilities.batch)
        }
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: {
          code: 'statlog.capabilities_transport_failed',
          message: 'StatLog capabilities transport failed.',
          details: String(error)
        }
      }
    }
  }

  private canCollect(): boolean {
    return this.telemetryEnabled && !this.optedOut
  }

  private async clearQueue(): Promise<void> {
    this.queue = []
    this.nextRetryAtMs = 0
    this.lastErrorCode = ''
    if (this.storage) {
      try {
        await this.storage.clear()
      } catch (error) {
        this.emitDiagnostic('warn', 'Unable to clear StatLog queue.', {
          error: String(error)
        })
      }
    }
  }

  private clampQueue(events: StatLogQueuedEvent[]): StatLogQueuedEvent[] {
    if (events.length <= this.queueLimit) return events
    this.dropped += events.length - this.queueLimit
    return events.slice(events.length - this.queueLimit)
  }

  private clampQueueInPlace(): void {
    const clamped = this.clampQueue(this.queue)
    if (clamped !== this.queue) this.queue = clamped
  }

  private async persistQueue(): Promise<void> {
    if (!this.storage) return
    try {
      await this.storage.save(this.queue)
    } catch (error) {
      this.emitDiagnostic('warn', 'Unable to persist StatLog queue.', {
        error: String(error)
      })
    }
  }

  private scheduleRetry(code: string): void {
    const delay = Math.min(this.retryBaseMs * 2 ** this.retryAttempt, this.maxRetryMs)
    this.retryAttempt += 1
    this.nextRetryAtMs = this.clock() + delay
    this.lastErrorCode = code
  }

  private flushFailure(
    status: number,
    code: string,
    message: string,
    details?: unknown
  ): StatLogFlushFailure {
    this.emitDiagnostic(status === 429 ? 'warn' : 'error', message, {
      code,
      status,
      details
    })
    return {
      ok: false,
      accepted: 0,
      rejected: 0,
      status,
      error: { code, message, details }
    }
  }

  private emitDiagnostic(
    level: DiagnosticEvent['level'],
    message: string,
    context?: Record<string, unknown>
  ): void {
    const safeContext = context ? (redactSecrets(context) as Record<string, unknown>) : undefined
    void this.diagnostics({ level, message, context: safeContext })
  }
}

export function createStatLogClient(options: StatLogClientOptions): StatLogClient {
  return new StatLogClient(options)
}

export async function createStatLog(options: StatLogClientOptions): Promise<StatLogClient> {
  const client = createStatLogClient(options)
  return client.setup()
}
