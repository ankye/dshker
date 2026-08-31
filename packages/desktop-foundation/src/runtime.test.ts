import { describe, expect, it, vi } from 'vitest'
import {
  type RepositoryStorage,
  createDialogStore,
  createEventBus,
  createJsonRepository,
  createMemoryRepositoryStorage,
  createNetworkClient,
  createStateStore,
  createWorkflowStore,
  defineValidator,
  runDataAction,
  validation
} from './runtime'

interface TodoRecord {
  id: string
  title: string
  done: boolean
}

const todoValidator = defineValidator<TodoRecord>(
  (value): value is TodoRecord =>
    Boolean(
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'title' in value &&
      typeof value.title === 'string' &&
      'done' in value &&
      typeof value.done === 'boolean'
    ),
  'Invalid todo record.'
)

describe('runtime foundation', () => {
  it('runs workflow lifecycle with progress, cancel, retry, complete, and failure state', () => {
    let now = 100
    const store = createWorkflowStore(() => now)
    const workflow = store.start({ name: 'Import' })

    now = 110
    expect(store.update(workflow.id, { progress: 40, message: 'Reading' })).toMatchObject({
      ok: true,
      data: { progress: 40, message: 'Reading', updatedAtMs: 110 }
    })
    expect(store.cancel(workflow.id)).toMatchObject({
      ok: true,
      data: { status: 'cancelled' }
    })
    expect(store.retry(workflow.id)).toMatchObject({
      ok: true,
      data: { status: 'running', attempts: 2 }
    })
    expect(store.complete(workflow.id, { count: 2 })).toMatchObject({
      ok: true,
      data: { status: 'completed', progress: 100, result: { count: 2 } }
    })

    const failed = store.start({ name: 'Upload' })
    expect(
      store.fail(failed.id, {
        code: 'upload.failed',
        message: 'Upload failed.',
        details: { token: 'secret' }
      })
    ).toMatchObject({
      ok: true,
      data: {
        status: 'failed',
        error: { details: { token: '[redacted]' } }
      }
    })
  })

  it('manages state updates, derived reads, reset, and unsubscribe lifecycle', () => {
    const store = createStateStore({ sidebarOpen: true, count: 0 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    expect(store.set({ count: 1 })).toEqual({ sidebarOpen: true, count: 1 })
    expect(store.select((state) => state.count + 1)).toBe(2)
    unsubscribe()
    store.set({ count: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.reset()).toEqual({ sidebarOpen: true, count: 0 })
  })

  it('queues and resolves dialogs through typed requests', () => {
    const dialogs = createDialogStore(() => 500)
    const dialog = dialogs.open({
      kind: 'confirm',
      title: 'Delete item',
      message: 'Delete this item?'
    })

    expect(dialog).toMatchObject({ id: 'dialog_1', openedAtMs: 500 })
    expect(dialogs.list()).toHaveLength(1)
    expect(dialogs.resolve(dialog.id, true)).toEqual({ ok: true, data: true })
    expect(dialogs.list()).toHaveLength(0)
    expect(dialogs.dismiss('missing')).toMatchObject({
      ok: false,
      error: { code: 'dialog.not_found' }
    })
  })

  it('publishes validated events and clears scoped subscriptions', () => {
    type Events = {
      'settings.changed': { theme: string }
    }
    const listener = vi.fn()
    const bus = createEventBus<Events>({
      validators: {
        'settings.changed': validation.object as never
      }
    })

    bus.subscribe('settings.changed', listener, { scope: 'view' })
    expect(bus.publish('settings.changed', { theme: 'dark' })).toEqual({
      ok: true,
      data: 1
    })
    expect(bus.publish('settings.changed', 'bad' as never)).toMatchObject({
      ok: false,
      error: { code: 'validation.invalid_type' }
    })
    bus.clearScope('view')
    expect(bus.listenerCount()).toBe(0)
  })

  it('runs data actions through validation, workflow, diagnostics, and typed results', async () => {
    const workflow = createWorkflowStore(() => 1)
    const diagnostics = vi.fn()

    await expect(
      runDataAction({
        name: 'Uppercase',
        input: 'hello',
        validate: validation.nonEmptyString,
        workflow,
        diagnostics,
        run: (value) => ({ ok: true, data: value.toUpperCase() })
      })
    ).resolves.toEqual({ ok: true, data: 'HELLO' })
    expect(workflow.list()[0]).toMatchObject({
      status: 'completed',
      result: 'HELLO'
    })
    expect(diagnostics).toHaveBeenCalled()

    await expect(
      runDataAction({
        name: 'Uppercase',
        input: '',
        validate: validation.nonEmptyString,
        run: (value) => ({ ok: true, data: value })
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation.invalid_type' }
    })
  })

  it('stores typed records through a repository with validation and batch writes', async () => {
    const repository = createJsonRepository({
      namespace: 'todos',
      storage: createMemoryRepositoryStorage(),
      validate: todoValidator
    })

    await expect(repository.save({ id: '1', title: 'Ship', done: false })).resolves.toMatchObject({
      ok: true,
      data: { id: '1' }
    })
    await expect(repository.get('1')).resolves.toMatchObject({
      ok: true,
      data: { title: 'Ship' }
    })
    await expect(
      repository.saveMany([
        { id: '2', title: 'Test', done: false },
        { id: '3', title: 'Release', done: false }
      ])
    ).resolves.toMatchObject({ ok: true, data: [{ id: '2' }, { id: '3' }] })
    await repository.remove('1')
    await expect(repository.get('1')).resolves.toEqual({
      ok: true,
      data: undefined
    })
    await expect(repository.save({ id: 'bad', title: 'Bad' } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation.failed' }
    })
    await expect(repository.get('../bad')).resolves.toMatchObject({
      ok: false,
      error: { code: 'storage.invalid_key' }
    })
  })

  it('migrates versioned repository records', async () => {
    const storage = createMemoryRepositoryStorage()
    await storage.write('todos', 'legacy', {
      __desktopRepositoryVersion: 1,
      record: { id: 'legacy', title: 'Legacy' }
    })

    const repository = createJsonRepository({
      namespace: 'todos',
      storage,
      validate: todoValidator,
      version: 2,
      migrations: [
        {
          from: 1,
          to: 2,
          migrate(record) {
            return {
              ...(record as { id: string; title: string }),
              done: false
            }
          }
        }
      ]
    })

    await expect(repository.get('legacy')).resolves.toEqual({
      ok: true,
      data: { id: 'legacy', title: 'Legacy', done: false }
    })
  })

  it('rolls back repository batch writes when a storage adapter fails', async () => {
    const baseStorage = createMemoryRepositoryStorage()
    await baseStorage.write('todos', 'existing', {
      id: 'existing',
      title: 'Existing',
      done: false
    })

    const failingStorage: RepositoryStorage = {
      read: (namespace, key, fallback) => baseStorage.read(namespace, key, fallback),
      async write(namespace, key, value) {
        if (key === 'bad') throw new Error('disk full')
        await baseStorage.write(namespace, key, value)
      },
      remove: (namespace, key) => baseStorage.remove(namespace, key)
    }
    const repository = createJsonRepository({
      namespace: 'todos',
      storage: failingStorage,
      validate: todoValidator
    })

    await expect(
      repository.saveMany([
        { id: 'existing', title: 'Updated', done: true },
        { id: 'bad', title: 'Bad', done: false }
      ])
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'storage.batch_failed' }
    })
    await expect(repository.get('existing')).resolves.toEqual({
      ok: true,
      data: { id: 'existing', title: 'Existing', done: false }
    })
  })

  it('calls network services with base URL, retries, response validation, and errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('fail', {
          status: 503,
          headers: { 'content-type': 'text/plain' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '1', title: 'Loaded', done: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response('missing', {
          status: 404,
          headers: { 'content-type': 'text/plain' }
        })
      )
    const client = createNetworkClient({
      baseUrl: 'https://api.example.test',
      retries: 1,
      fetchImpl: fetchImpl as never
    })

    await expect(client.request({ path: '/todos/1', validate: todoValidator })).resolves.toEqual({
      ok: true,
      data: { id: '1', title: 'Loaded', done: true }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await expect(client.request({ path: '/missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'network.request_failed' }
    })
  })
})
