import { describe, expect, it } from 'vitest'
import type { CoreRemoteConnection, CoreRemoteRoutePort } from '../core/remote-route'
import { RemoteConnectionError } from './errors'
import { RemoteConnectionService } from './service'

const connection: CoreRemoteConnection = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Studio Mac',
  host: 'studio-mac',
  port: 22,
  user: 'dev',
  sshKeyPath: '',
  configRevision: 'revision-1'
}

/** A core route whose operations the test drives. */
function route(options: { readonly failConnect?: boolean } = {}) {
  let records: CoreRemoteConnection[] = [connection]
  let live = false
  const port: CoreRemoteRoutePort = {
    async inspectCatalog() {
      return records
    },
    async createConnection() {
      return records
    },
    async updateConnection(request) {
      records = records.map((entry) =>
        entry.connectionId === request.connectionId
          ? {
              ...entry,
              displayName: request.displayName,
              host: request.host,
              port: request.port,
              user: request.user,
              sshKeyPath: request.sshKeyPath,
              configRevision: 'revision-2'
            }
          : entry
      )
      return records
    },
    async removeConnection(request: Readonly<{ filePath: string; connectionId: string }>) {
      records = records.filter((entry) => entry.connectionId !== request.connectionId)
      return records
    },
    async connect() {
      if (options.failConnect === true)
        throw new RemoteConnectionError('remote.tunnel_failed', 'boom')
      live = true
      return { url: 'http://127.0.0.1:41000/?token=abc' }
    },
    async disconnect() {
      if (!live) throw new RemoteConnectionError('remote.connection_not_found', 'not connected')
      live = false
    },
    async status() {
      return live ? { url: 'http://127.0.0.1:41000/?token=abc' } : undefined
    },
    async startBroker() {
      return { port: 41001, instanceId: 'instance' }
    },
    async stopBroker() {
      return undefined
    }
  }
  return { port, isLive: () => live }
}

function serviceFor(port: CoreRemoteRoutePort) {
  return new RemoteConnectionService(
    async () => '/settings/dsh-launcher/remote-connections.json',
    () => port
  )
}

describe('RemoteConnectionService', () => {
  it('restores records disconnected and publishes ready from the core', async () => {
    const { port } = route()
    const service = serviceFor(port)
    const events: string[] = []
    service.onStateChange((state) => events.push(state.connections[0]?.status.kind ?? 'empty'))
    expect((await service.getState()).connections[0]?.status.kind).toBe('disconnected')
    expect((await service.getState()).connections[0]?.testStatus.kind).toBe('untested')
    expect((await service.connect(connection.connectionId)).connections[0]?.status.kind).toBe(
      'ready'
    )
    expect(events).toEqual(['connecting', 'ready'])
    await service.disconnect(connection.connectionId)
    expect((await service.getState()).connections[0]?.status.kind).toBe('disconnected')
  })

  it('tests through the core and stays disconnected', async () => {
    const { port, isLive } = route()
    const service = serviceFor(port)
    const state = await service.test(connection.connectionId)
    expect(isLive()).toBe(false)
    expect(state.connections[0]?.status.kind).toBe('disconnected')
    expect(state.connections[0]?.testStatus.kind).toBe('passed')
  })

  it('reports a typed failure without leaving a live connection', async () => {
    const service = serviceFor(route({ failConnect: true }).port)
    await expect(service.connect(connection.connectionId)).rejects.toMatchObject({
      code: 'remote.tunnel_failed'
    })
    const state = await service.getState()
    expect(state.connections[0]?.status).toMatchObject({ kind: 'failed' })
    expect(state.connections[0]?.testStatus).toMatchObject({ kind: 'failed' })
  })

  it('refuses a second connect while one is in flight', async () => {
    let release: (() => void) | undefined
    const { port } = route()
    const slow: CoreRemoteRoutePort = {
      ...port,
      connect: () =>
        new Promise((resolve) => {
          release = () => resolve({ url: 'http://127.0.0.1:41000/' })
        })
    }
    const service = serviceFor(slow)
    const connecting = service.connect(connection.connectionId)
    // The service resolves the catalog before it reaches the port, so wait until
    // the in-flight call is actually pending.
    for (let attempt = 0; attempt < 50 && release === undefined; attempt += 1) {
      await Promise.resolve()
    }
    await expect(service.connect(connection.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_busy'
    })
    release?.()
    await connecting
  })

  it('keeps a failed row and requires disconnect before removal', async () => {
    const service = serviceFor(route({ failConnect: true }).port)
    await expect(service.connect(connection.connectionId)).rejects.toThrow('boom')
    await expect(service.remove(connection.connectionId)).rejects.toMatchObject({
      code: 'remote.connection_not_disconnected'
    })
  })

  it('refuses every operation when the shell has no core', async () => {
    const service = new RemoteConnectionService(
      async () => '/settings/dsh-launcher/remote-connections.json',
      () => undefined
    )
    await expect(service.getState()).rejects.toMatchObject({ code: 'remote.persistence_failed' })
    await expect(service.connect(connection.connectionId)).rejects.toMatchObject({
      code: 'remote.persistence_failed'
    })
  })

  it('invalidates a passed test when only the SSH identity path changes', async () => {
    const { port } = route()
    const service = serviceFor(port)
    await service.test(connection.connectionId)
    const updated = await service.update({
      ...connection,
      sshKeyPath: '/example/.ssh/new_identity',
      expectedConfigRevision: connection.configRevision
    })
    expect(updated.connections[0]).toMatchObject({
      sshKeyPath: '/example/.ssh/new_identity',
      status: { kind: 'disconnected' },
      testStatus: { kind: 'untested' }
    })
  })

  it('rejects an SSH identity path change while connected without writing the catalog', async () => {
    const { port } = route()
    const service = serviceFor(port)
    await service.connect(connection.connectionId)
    await expect(
      service.update({
        ...connection,
        sshKeyPath: '/example/.ssh/new_identity',
        expectedConfigRevision: connection.configRevision
      })
    ).rejects.toMatchObject({ code: 'remote.connection_not_disconnected' })
    expect((await service.getState()).connections[0]).toMatchObject({
      sshKeyPath: '',
      status: { kind: 'ready' }
    })
  })

  it('rejects an SSH identity path change while a connection test is in flight', async () => {
    let release: (() => void) | undefined
    const { port } = route()
    const slow: CoreRemoteRoutePort = {
      ...port,
      connect: () =>
        new Promise((resolve) => {
          release = () => resolve({ url: 'http://127.0.0.1:41000/' })
        }),
      disconnect: async () => undefined
    }
    const service = serviceFor(slow)
    const testing = service.test(connection.connectionId)
    for (let attempt = 0; attempt < 50 && release === undefined; attempt += 1) {
      await Promise.resolve()
    }
    expect(release).toBeDefined()
    await expect(
      service.update({
        ...connection,
        sshKeyPath: '/example/.ssh/new_identity',
        expectedConfigRevision: connection.configRevision
      })
    ).rejects.toMatchObject({ code: 'remote.connection_not_disconnected' })
    expect((await service.getState()).connections[0]?.sshKeyPath).toBe('')
    release?.()
    await testing
  })
})
