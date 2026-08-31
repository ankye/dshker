import { describe, expect, it, vi } from 'vitest'
import {
  createDialogStore,
  createEventBus,
  createJsonRepository,
  createMemoryRepositoryStorage,
  createNetworkClient,
  createWorkflowStore,
  defineValidator,
  runDataAction
} from './runtime'
import { resolveRuntimeConfig } from './config'
import { createMemorySecureStorageAdapter, createSecureRepositoryStorage } from './storage'

interface ProjectRecord {
  id: string
  name: string
}

const projectValidator = defineValidator<ProjectRecord>(
  (value): value is ProjectRecord =>
    Boolean(
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'name' in value &&
      typeof value.name === 'string'
    ),
  'Invalid project record.'
)

describe('runtime foundation e2e', () => {
  it('runs a representative config, action, workflow, event, repository, and network flow', async () => {
    type Events = {
      'project.saved': ProjectRecord
    }
    const runtimeConfig = resolveRuntimeConfig({
      argv: ['--env=local', '--feature=network=true'],
      environments: {
        local: {
          values: { apiBaseUrl: 'https://api.example.test' }
        }
      }
    })
    const workflow = createWorkflowStore(() => 10)
    const dialogs = createDialogStore(() => 10)
    const bus = createEventBus<Events>()
    const savedEvents: ProjectRecord[] = []
    bus.subscribe('project.saved', (project) => savedEvents.push(project))

    const repository = createJsonRepository({
      namespace: 'projects',
      storage: createMemoryRepositoryStorage(),
      validate: projectValidator
    })
    const secureRepository = createJsonRepository({
      namespace: 'secure-projects',
      storage: createSecureRepositoryStorage(createMemorySecureStorageAdapter()),
      validate: projectValidator,
      version: 1
    })
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ id: 'remote', name: 'Remote Project' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const network = createNetworkClient({
      baseUrl: String(runtimeConfig.values.apiBaseUrl),
      fetchImpl: fetchImpl as never
    })
    const failingNetwork = createNetworkClient({
      baseUrl: String(runtimeConfig.values.apiBaseUrl),
      fetchImpl: vi.fn(async () => new Response('offline', { status: 503 })) as never,
      retries: 0
    })

    const result = await runDataAction({
      name: 'LoadAndSaveProject',
      input: { id: 'local', name: 'Local Project' },
      validate: projectValidator,
      workflow,
      async run(project) {
        const dialog = dialogs.open({
          kind: 'confirm',
          title: 'Save project',
          message: 'Save this project?'
        })
        dialogs.resolve(dialog.id, true)
        await repository.save(project)
        await secureRepository.save({ id: project.id, name: 'secure' })
        bus.publish('project.saved', project)
        return network.request({
          path: '/projects/remote',
          validate: projectValidator
        })
      }
    })

    expect(result).toEqual({
      ok: true,
      data: { id: 'remote', name: 'Remote Project' }
    })
    await expect(repository.get('local')).resolves.toMatchObject({
      ok: true,
      data: { name: 'Local Project' }
    })
    await expect(secureRepository.get('local')).resolves.toMatchObject({
      ok: true,
      data: { name: 'secure' }
    })
    expect(savedEvents).toEqual([{ id: 'local', name: 'Local Project' }])
    expect(dialogs.list()).toHaveLength(0)
    await expect(failingNetwork.request({ path: '/offline' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'network.request_failed' }
    })
    expect(workflow.list()[0]).toMatchObject({
      name: 'LoadAndSaveProject',
      status: 'completed',
      result: { id: 'remote', name: 'Remote Project' }
    })
  })
})
