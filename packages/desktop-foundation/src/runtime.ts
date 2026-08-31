import type { ApiResult, DiagnosticEvent } from './contracts'
import { bridgeFail, bridgeOk } from './bridge'
import { redactSecrets } from './logger'

export type Validator<T> = (value: unknown) => ApiResult<T>
export type Unsubscribe = () => void

export const validation = {
  string(value: unknown): ApiResult<string> {
    return typeof value === 'string'
      ? bridgeOk(value)
      : bridgeFail('validation.invalid_type', 'Expected a string.')
  },
  nonEmptyString(value: unknown): ApiResult<string> {
    return typeof value === 'string' && value.trim() !== ''
      ? bridgeOk(value)
      : bridgeFail('validation.invalid_type', 'Expected a non-empty string.')
  },
  boolean(value: unknown): ApiResult<boolean> {
    return typeof value === 'boolean'
      ? bridgeOk(value)
      : bridgeFail('validation.invalid_type', 'Expected a boolean.')
  },
  object(value: unknown): ApiResult<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? bridgeOk(value as Record<string, unknown>)
      : bridgeFail('validation.invalid_type', 'Expected an object.')
  }
}

export function defineValidator<T>(
  guard: (value: unknown) => value is T,
  message = 'Validation failed.'
): Validator<T> {
  return (value) => (guard(value) ? bridgeOk(value) : bridgeFail('validation.failed', message))
}

function emitDiagnostic(
  diagnostics: ((event: DiagnosticEvent) => void) | undefined,
  event: DiagnosticEvent
): void {
  diagnostics?.({
    ...event,
    context: event.context ? (redactSecrets(event.context) as Record<string, unknown>) : undefined
  })
}

export interface EventBusOptions<TEvents extends Record<string, unknown>> {
  validators?: Partial<{ [K in keyof TEvents]: Validator<TEvents[K]> }>
  diagnostics?: (event: DiagnosticEvent) => void
}

export interface EventBus<TEvents extends Record<string, unknown>> {
  publish<K extends keyof TEvents & string>(name: K, payload: TEvents[K]): ApiResult<number>
  subscribe<K extends keyof TEvents & string>(
    name: K,
    handler: (payload: TEvents[K]) => void,
    options?: { scope?: string }
  ): Unsubscribe
  clearScope(scope: string): void
  listenerCount(name?: keyof TEvents & string): number
}

export function createEventBus<TEvents extends Record<string, unknown>>(
  options: EventBusOptions<TEvents> = {}
): EventBus<TEvents> {
  const listeners = new Map<
    keyof TEvents & string,
    { handler: (payload: TEvents[keyof TEvents]) => void; scope?: string }[]
  >()

  return {
    publish(name, payload) {
      const validator = options.validators?.[name]
      if (validator) {
        const result = validator(payload)
        if (!result.ok) return result
      }

      const active = listeners.get(name) || []
      for (const listener of active) listener.handler(payload)
      emitDiagnostic(options.diagnostics, {
        level: 'debug',
        message: 'Runtime event published.',
        context: { name, listeners: active.length }
      })
      return bridgeOk(active.length)
    },
    subscribe(name, handler, subscribeOptions = {}) {
      const active = listeners.get(name) || []
      const entry = {
        handler: handler as (payload: TEvents[keyof TEvents]) => void,
        scope: subscribeOptions.scope
      }
      active.push(entry)
      listeners.set(name, active)

      return () => {
        const next = (listeners.get(name) || []).filter((item) => item !== entry)
        if (next.length) listeners.set(name, next)
        else listeners.delete(name)
      }
    },
    clearScope(scope) {
      for (const [name, active] of listeners.entries()) {
        const next = active.filter((listener) => listener.scope !== scope)
        if (next.length) listeners.set(name, next)
        else listeners.delete(name)
      }
    },
    listenerCount(name) {
      if (name) return listeners.get(name)?.length || 0
      return [...listeners.values()].reduce((total, active) => total + active.length, 0)
    }
  }
}

export type WorkflowStatus = 'running' | 'cancelled' | 'completed' | 'failed'

export interface WorkflowState<T = unknown> {
  id: string
  name: string
  status: WorkflowStatus
  progress: number
  message: string
  attempts: number
  startedAtMs: number
  updatedAtMs: number
  result?: T
  error?: { code: string; message: string; details?: unknown }
}

export interface WorkflowStore {
  start(input: { id?: string; name: string; message?: string }): WorkflowState
  update(id: string, patch: { progress?: number; message?: string }): ApiResult<WorkflowState>
  cancel(id: string, message?: string): ApiResult<WorkflowState>
  complete<T>(id: string, result?: T): ApiResult<WorkflowState<T>>
  fail(
    id: string,
    error: { code: string; message: string; details?: unknown }
  ): ApiResult<WorkflowState>
  retry(id: string): ApiResult<WorkflowState>
  get(id: string): WorkflowState | undefined
  list(): WorkflowState[]
}

export function createWorkflowStore(clock: () => number = Date.now): WorkflowStore {
  const workflows = new Map<string, WorkflowState>()
  let nextId = 1

  function touch(workflow: WorkflowState): WorkflowState {
    workflow.updatedAtMs = clock()
    return workflow
  }

  function find(id: string): ApiResult<WorkflowState> {
    const workflow = workflows.get(id)
    return workflow ? bridgeOk(workflow) : bridgeFail('workflow.not_found', 'Workflow not found.')
  }

  return {
    start(input) {
      const now = clock()
      const workflow: WorkflowState = {
        id: input.id || `workflow_${nextId++}`,
        name: input.name,
        status: 'running',
        progress: 0,
        message: input.message || '',
        attempts: 1,
        startedAtMs: now,
        updatedAtMs: now
      }
      workflows.set(workflow.id, workflow)
      return { ...workflow }
    },
    update(id, patch) {
      const result = find(id)
      if (!result.ok) return result
      const workflow = result.data
      workflow.progress = Math.max(0, Math.min(100, patch.progress ?? workflow.progress))
      workflow.message = patch.message ?? workflow.message
      return bridgeOk({ ...touch(workflow) })
    },
    cancel(id, message = 'Cancelled') {
      const result = find(id)
      if (!result.ok) return result
      result.data.status = 'cancelled'
      result.data.message = message
      return bridgeOk({ ...touch(result.data) })
    },
    complete(id, resultValue) {
      const result = find(id)
      if (!result.ok) return result
      result.data.status = 'completed'
      result.data.progress = 100
      result.data.result = resultValue
      return bridgeOk({ ...touch(result.data), result: resultValue })
    },
    fail(id, error) {
      const result = find(id)
      if (!result.ok) return result
      result.data.status = 'failed'
      result.data.error = {
        ...error,
        details: redactSecrets(error.details)
      }
      result.data.message = error.message
      return bridgeOk({ ...touch(result.data) })
    },
    retry(id) {
      const result = find(id)
      if (!result.ok) return result
      result.data.status = 'running'
      result.data.progress = 0
      result.data.error = undefined
      result.data.attempts += 1
      return bridgeOk({ ...touch(result.data) })
    },
    get(id) {
      const workflow = workflows.get(id)
      return workflow ? { ...workflow } : undefined
    },
    list() {
      return [...workflows.values()].map((workflow) => ({ ...workflow }))
    }
  }
}

export interface StateStore<TState extends Record<string, unknown>> {
  get(): TState
  set(patch: Partial<TState> | ((state: TState) => Partial<TState>)): TState
  reset(nextState?: TState): TState
  subscribe(listener: (state: TState) => void): Unsubscribe
  select<TValue>(selector: (state: TState) => TValue): TValue
}

export function createStateStore<TState extends Record<string, unknown>>(
  initialState: TState
): StateStore<TState> {
  let state = { ...initialState }
  const listeners = new Set<(state: TState) => void>()

  function notify(): void {
    const snapshot = { ...state }
    for (const listener of listeners) listener(snapshot)
  }

  return {
    get() {
      return { ...state }
    },
    set(patch) {
      const nextPatch = typeof patch === 'function' ? patch({ ...state }) : patch
      state = { ...state, ...nextPatch }
      notify()
      return { ...state }
    },
    reset(nextState = initialState) {
      state = { ...nextState }
      notify()
      return { ...state }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    select(selector) {
      return selector({ ...state })
    }
  }
}

export type DialogKind = 'confirm' | 'modal' | 'error' | 'progress' | 'file-picker' | 'destructive'

export interface DialogRequest<TPayload = unknown> {
  id?: string
  kind: DialogKind
  title: string
  message?: string
  payload?: TPayload
}

export interface DialogRecord<TPayload = unknown> extends DialogRequest<TPayload> {
  id: string
  openedAtMs: number
}

export interface DialogStore {
  open<TPayload = unknown>(request: DialogRequest<TPayload>): DialogRecord<TPayload>
  resolve<T = unknown>(id: string, value: T): ApiResult<T>
  dismiss(id: string, reason?: string): ApiResult<void>
  get(id: string): DialogRecord | undefined
  list(): DialogRecord[]
}

export function createDialogStore(clock: () => number = Date.now): DialogStore {
  const dialogs = new Map<string, DialogRecord>()
  let nextId = 1

  return {
    open<TPayload = unknown>(request: DialogRequest<TPayload>): DialogRecord<TPayload> {
      const dialog: DialogRecord<TPayload> = {
        ...request,
        id: request.id || `dialog_${nextId++}`,
        openedAtMs: clock()
      }
      dialogs.set(dialog.id, dialog)
      return { ...dialog }
    },
    resolve(id, value) {
      if (!dialogs.has(id)) return bridgeFail('dialog.not_found', 'Dialog not found.')
      dialogs.delete(id)
      return bridgeOk(value)
    },
    dismiss(id) {
      if (!dialogs.has(id)) return bridgeFail('dialog.not_found', 'Dialog not found.')
      dialogs.delete(id)
      return bridgeOk(undefined)
    },
    get(id) {
      const dialog = dialogs.get(id)
      return dialog ? { ...dialog } : undefined
    },
    list() {
      return [...dialogs.values()].map((dialog) => ({ ...dialog }))
    }
  }
}

export interface DataActionInput<TInput, TOutput> {
  name: string
  input: unknown
  validate: Validator<TInput>
  workflow?: WorkflowStore
  diagnostics?: (event: DiagnosticEvent) => void
  run(input: TInput): Promise<ApiResult<TOutput>> | ApiResult<TOutput>
}

export async function runDataAction<TInput, TOutput>(
  action: DataActionInput<TInput, TOutput>
): Promise<ApiResult<TOutput>> {
  const validationResult = action.validate(action.input)
  if (!validationResult.ok) return validationResult

  const workflow = action.workflow?.start({ name: action.name })
  emitDiagnostic(action.diagnostics, {
    level: 'debug',
    message: 'Runtime action started.',
    context: { name: action.name, workflowId: workflow?.id }
  })

  try {
    const result = await action.run(validationResult.data)
    if (result.ok) action.workflow?.complete(workflow?.id || '', result.data)
    else {
      action.workflow?.fail(workflow?.id || '', result.error)
      emitDiagnostic(action.diagnostics, {
        level: 'warn',
        message: 'Runtime action failed.',
        context: { name: action.name, error: result.error }
      })
    }
    return result
  } catch (error) {
    const failure = bridgeFail<TOutput>(
      'runtime.action_failed',
      'Runtime action failed.',
      error instanceof Error ? error.message : String(error)
    )
    action.workflow?.fail(workflow?.id || '', failure.error)
    return failure
  }
}

export type RepositoryBatchOperation =
  | { type: 'write'; namespace: string; key: string; value: unknown }
  | { type: 'remove'; namespace: string; key: string }

export interface RepositoryStorage {
  read<T>(namespace: string, key: string, fallback: T): Promise<T>
  write(namespace: string, key: string, value: unknown): Promise<void>
  remove(namespace: string, key: string): Promise<void>
  batch?(operations: RepositoryBatchOperation[]): Promise<void>
}

export function createMemoryRepositoryStorage(): RepositoryStorage {
  const records = new Map<string, unknown>()
  const keyFor = (namespace: string, key: string) => `${namespace}:${key}`

  return {
    async read(namespace, key, fallback) {
      return (
        records.has(keyFor(namespace, key)) ? records.get(keyFor(namespace, key)) : fallback
      ) as typeof fallback
    },
    async write(namespace, key, value) {
      records.set(keyFor(namespace, key), value)
    },
    async remove(namespace, key) {
      records.delete(keyFor(namespace, key))
    },
    async batch(operations) {
      const snapshot = new Map(records)
      try {
        for (const operation of operations) {
          if (operation.type === 'write') {
            records.set(keyFor(operation.namespace, operation.key), operation.value)
          } else {
            records.delete(keyFor(operation.namespace, operation.key))
          }
        }
      } catch (error) {
        records.clear()
        for (const [key, value] of snapshot.entries()) records.set(key, value)
        throw error
      }
    }
  }
}

export interface RepositoryMigration {
  from: number
  to: number
  migrate(record: unknown): unknown
}

export interface JsonRepository<TRecord extends { id: string }> {
  get(id: string): Promise<ApiResult<TRecord | undefined>>
  save(record: TRecord): Promise<ApiResult<TRecord>>
  saveMany(records: TRecord[]): Promise<ApiResult<TRecord[]>>
  remove(id: string): Promise<ApiResult<void>>
}

interface RepositoryRecordEnvelope {
  __desktopRepositoryVersion: number
  record: unknown
}

const REPOSITORY_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/
const REPOSITORY_MISSING = Symbol('repository.missing')

function validateRepositoryPath(
  value: string,
  label: string,
  allowSlashes: boolean
): ApiResult<void> {
  const segments = allowSlashes ? value.split('/').filter(Boolean) : [value]
  if (!value || (!allowSlashes && value.includes('/')) || segments.length === 0) {
    return bridgeFail('storage.invalid_key', `Invalid repository ${label}.`, {
      value
    })
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !REPOSITORY_SEGMENT_PATTERN.test(segment)) {
      return bridgeFail('storage.invalid_key', `Invalid repository ${label}.`, {
        value
      })
    }
  }
  return bridgeOk(undefined)
}

function isRepositoryRecordEnvelope(value: unknown): value is RepositoryRecordEnvelope {
  return Boolean(
    value &&
    typeof value === 'object' &&
    '__desktopRepositoryVersion' in value &&
    typeof value.__desktopRepositoryVersion === 'number' &&
    'record' in value
  )
}

function currentRepositoryVersion(options: {
  version?: number
  migrations?: RepositoryMigration[]
}): number | undefined {
  if (options.version !== undefined) return options.version
  const versions = options.migrations?.map((migration) => migration.to) || []
  return versions.length ? Math.max(...versions) : undefined
}

function encodeRepositoryRecord(record: unknown, version: number | undefined): unknown {
  return version === undefined
    ? record
    : {
        __desktopRepositoryVersion: version,
        record
      }
}

function decodeRepositoryRecord(
  raw: unknown,
  options: {
    version?: number
    legacyVersion?: number
    migrations?: RepositoryMigration[]
    migrate?: (record: unknown) => unknown
  }
): ApiResult<unknown> {
  const targetVersion = currentRepositoryVersion(options)
  let version = targetVersion
  let record = raw

  if (isRepositoryRecordEnvelope(raw)) {
    version = raw.__desktopRepositoryVersion
    record = raw.record
  } else if (targetVersion !== undefined) {
    version = options.legacyVersion ?? 1
  }

  try {
    if (options.migrate) record = options.migrate(record)

    if (targetVersion !== undefined) {
      if (version === undefined || !Number.isInteger(version) || version < 1) {
        return bridgeFail('storage.migration_failed', 'Repository record version is invalid.', {
          version
        })
      }
      if (version > targetVersion) {
        return bridgeFail('storage.migration_failed', 'Repository record version is newer.', {
          version,
          targetVersion
        })
      }

      while (version < targetVersion) {
        const migration = options.migrations?.find((item) => item.from === version)
        if (!migration || migration.to <= version || migration.to > targetVersion) {
          return bridgeFail('storage.migration_failed', 'Repository migration path is missing.', {
            version,
            targetVersion
          })
        }
        record = migration.migrate(record)
        version = migration.to
      }
    }
  } catch (error) {
    return bridgeFail('storage.migration_failed', 'Repository migration failed.', String(error))
  }

  return bridgeOk(record)
}

async function applyRepositoryBatch(
  storage: RepositoryStorage,
  operations: RepositoryBatchOperation[]
): Promise<void> {
  if (storage.batch) {
    await storage.batch(operations)
    return
  }

  const rollback: RepositoryBatchOperation[] = []
  try {
    for (const operation of operations) {
      const previous = await storage.read<unknown>(
        operation.namespace,
        operation.key,
        REPOSITORY_MISSING
      )
      rollback.unshift(
        previous === REPOSITORY_MISSING
          ? {
              type: 'remove',
              namespace: operation.namespace,
              key: operation.key
            }
          : {
              type: 'write',
              namespace: operation.namespace,
              key: operation.key,
              value: previous
            }
      )

      if (operation.type === 'write') {
        await storage.write(operation.namespace, operation.key, operation.value)
      } else {
        await storage.remove(operation.namespace, operation.key)
      }
    }
  } catch (error) {
    for (const operation of rollback) {
      try {
        if (operation.type === 'write') {
          await storage.write(operation.namespace, operation.key, operation.value)
        } else {
          await storage.remove(operation.namespace, operation.key)
        }
      } catch {
        // Keep the original batch failure as the returned error.
      }
    }
    throw error
  }
}

export function createJsonRepository<TRecord extends { id: string }>(options: {
  namespace: string
  storage: RepositoryStorage
  validate: Validator<TRecord>
  version?: number
  legacyVersion?: number
  migrations?: RepositoryMigration[]
  migrate?: (record: unknown) => unknown
}): JsonRepository<TRecord> {
  const repositoryVersion = currentRepositoryVersion(options)
  const validateNamespace = () => validateRepositoryPath(options.namespace, 'namespace', true)
  const validateKey = (key: string) => validateRepositoryPath(key, 'key', false)

  return {
    async get(id) {
      const namespace = validateNamespace()
      if (!namespace.ok) return namespace
      const key = validateKey(id)
      if (!key.ok) return key

      try {
        const raw = await options.storage.read<unknown>(options.namespace, id, undefined)
        if (raw === undefined) return bridgeOk(undefined)
        const decoded = decodeRepositoryRecord(raw, options)
        if (!decoded.ok) return decoded
        return options.validate(decoded.data)
      } catch (error) {
        return bridgeFail('storage.read_failed', 'Repository read failed.', String(error))
      }
    },
    async save(record) {
      const namespace = validateNamespace()
      if (!namespace.ok) return namespace
      const key = validateKey(record.id)
      if (!key.ok) return key

      const result = options.validate(record)
      if (!result.ok) return result
      try {
        await options.storage.write(
          options.namespace,
          record.id,
          encodeRepositoryRecord(result.data, repositoryVersion)
        )
        return bridgeOk(result.data)
      } catch (error) {
        return bridgeFail('storage.write_failed', 'Repository write failed.', String(error))
      }
    },
    async saveMany(records) {
      const namespace = validateNamespace()
      if (!namespace.ok) return namespace
      const validated: TRecord[] = []

      for (const record of records) {
        const key = validateKey(record.id)
        if (!key.ok) return key
        const result = options.validate(record)
        if (!result.ok) return result
        validated.push(result.data)
      }

      try {
        await applyRepositoryBatch(
          options.storage,
          validated.map((record) => ({
            type: 'write',
            namespace: options.namespace,
            key: record.id,
            value: encodeRepositoryRecord(record, repositoryVersion)
          }))
        )
        return bridgeOk(validated)
      } catch (error) {
        return bridgeFail('storage.batch_failed', 'Repository batch write failed.', String(error))
      }
    },
    async remove(id) {
      const namespace = validateNamespace()
      if (!namespace.ok) return namespace
      const key = validateKey(id)
      if (!key.ok) return key

      try {
        await options.storage.remove(options.namespace, id)
        return bridgeOk(undefined)
      } catch (error) {
        return bridgeFail('storage.remove_failed', 'Repository remove failed.', String(error))
      }
    }
  }
}

export interface NetworkClientOptions {
  baseUrl: string
  timeoutMs?: number
  retries?: number
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>
  diagnostics?: (event: DiagnosticEvent) => void
}

export interface NetworkRequest<TOutput> {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
  validate?: Validator<TOutput>
}

export interface NetworkClient {
  request<TOutput = unknown>(request: NetworkRequest<TOutput>): Promise<ApiResult<TOutput>>
}

function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()
  return response.text()
}

export function createNetworkClient(options: NetworkClientOptions): NetworkClient {
  const fetchImpl = options.fetchImpl || globalThis.fetch

  return {
    async request<TOutput = unknown>(
      request: NetworkRequest<TOutput>
    ): Promise<ApiResult<TOutput>> {
      if (!fetchImpl) return bridgeFail('network.fetch_missing', 'Fetch implementation is missing.')

      const retries = request.retries ?? options.retries ?? 0
      let lastError: unknown

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const abortController = new AbortController()
        const timeout = globalThis.setTimeout(
          () => abortController.abort(),
          request.timeoutMs ?? options.timeoutMs ?? 8000
        )

        try {
          const authHeaders = options.getAuthHeaders ? await options.getAuthHeaders() : {}
          const response = await fetchImpl(joinUrl(options.baseUrl, request.path), {
            method: request.method || 'GET',
            headers: {
              ...options.headers,
              ...authHeaders,
              ...request.headers,
              ...(request.body === undefined ? {} : { 'content-type': 'application/json' })
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            signal: request.signal || abortController.signal
          })
          const body = await readResponseBody(response)

          if (!response.ok) {
            lastError = {
              status: response.status,
              body
            }
            if (response.status < 500 || attempt === retries) {
              return bridgeFail(
                'network.request_failed',
                `Network request failed: ${response.status}`,
                lastError
              )
            }
            continue
          }

          return request.validate ? request.validate(body) : bridgeOk(body as TOutput)
        } catch (error) {
          lastError = error
          if (attempt === retries) {
            emitDiagnostic(options.diagnostics, {
              level: 'warn',
              message: 'Network request failed.',
              context: { path: request.path, error: String(error) }
            })
            return bridgeFail(
              error instanceof DOMException && error.name === 'AbortError'
                ? 'network.timeout'
                : 'network.request_failed',
              'Network request failed.',
              String(error)
            )
          }
        } finally {
          globalThis.clearTimeout(timeout)
        }
      }

      return bridgeFail('network.request_failed', 'Network request failed.', String(lastError))
    }
  }
}
