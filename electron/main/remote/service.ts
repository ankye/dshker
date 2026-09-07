import type {
  CreateRemoteConnectionRequest,
  UpdateRemoteConnectionRequest,
  RemoteComputerView,
  RemoteConnectionErrorCode,
  RemoteConnectionsState,
  RemoteConnectionStatus,
  RemoteConnectionTestStatus
} from '../../../src/shared/contracts'
import { RemoteConnectionCatalog, assertConnectionId, remoteConfigRevision } from './catalog'
import { RemoteConnectionError } from './errors'
import type { OpenSshRemoteConnector, RemoteTunnel } from './openssh'

type StateListener = (state: RemoteConnectionsState) => void

/** Coordinates persisted computer identities and process-local SSH generations. */
export class RemoteConnectionService {
  readonly #status = new Map<string, RemoteConnectionStatus>()
  readonly #testStatus = new Map<string, RemoteConnectionTestStatus>()
  readonly #tunnels = new Map<string, RemoteTunnel>()
  readonly #generations = new Map<string, number>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #listeners = new Set<StateListener>()
  readonly #editing = new Set<string>()
  readonly #disconnecting = new Set<string>()

  constructor(
    private readonly catalog: Pick<
      RemoteConnectionCatalog,
      'load' | 'create' | 'update' | 'remove'
    >,
    private readonly connector: Pick<OpenSshRemoteConnector, 'connect'>
  ) {}

  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async getState(): Promise<RemoteConnectionsState> {
    return this.#project(await this.catalog.load())
  }

  async create(request: CreateRemoteConnectionRequest): Promise<RemoteConnectionsState> {
    const connections = await this.catalog.create(request)
    const state = this.#project(connections)
    this.#emit(state)
    return state
  }

  async connect(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    const current = this.#status.get(connectionId)?.kind ?? 'disconnected'
    if (current === 'connecting' || current === 'ready' || this.#controllers.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer is already connecting or ready.'
      )
    }
    const generation = (this.#generations.get(connectionId) ?? 0) + 1
    const controller = new AbortController()
    this.#generations.set(connectionId, generation)
    this.#controllers.set(connectionId, controller)
    this.#status.set(connectionId, { kind: 'connecting' })
    try {
      const computer = await this.#find(connectionId)
      this.#emit(await this.getState())
      if (controller.signal.aborted || this.#generations.get(connectionId) !== generation)
        return this.getState()
      const tunnel = await this.connector.connect(
        computer,
        () => {
          void this.#handleTunnelExit(connectionId, generation)
        },
        controller.signal
      )
      if (this.#generations.get(connectionId) !== generation) {
        await tunnel.stop()
        return this.getState()
      }
      this.#tunnels.set(connectionId, tunnel)
      this.#status.set(connectionId, { kind: 'ready', url: tunnel.url })
      this.#testStatus.set(connectionId, { kind: 'passed' })
      const state = await this.getState()
      this.#emit(state)
      return state
    } catch (error) {
      if (this.#generations.get(connectionId) === generation) {
        const failure = normalizeRemoteError(error)
        this.#status.set(connectionId, {
          kind: 'failed',
          code: failure.code,
          message: failure.message
        })
        this.#testStatus.set(connectionId, {
          kind: 'failed',
          code: failure.code,
          message: failure.message
        })
        this.#emit(await this.getState())
      }
      throw error
    } finally {
      if (this.#controllers.get(connectionId) === controller) {
        this.#controllers.delete(connectionId)
      }
    }
  }

  async test(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    const current = this.#status.get(connectionId)?.kind ?? 'disconnected'
    if (current === 'connecting' || current === 'ready' || this.#controllers.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer is connecting, connected, or already being tested.'
      )
    }
    const generation = (this.#generations.get(connectionId) ?? 0) + 1
    const controller = new AbortController()
    this.#generations.set(connectionId, generation)
    this.#controllers.set(connectionId, controller)
    this.#status.set(connectionId, { kind: 'disconnected' })
    this.#testStatus.set(connectionId, { kind: 'testing' })
    try {
      const computer = await this.#find(connectionId)
      this.#emit(await this.getState())
      if (controller.signal.aborted || this.#generations.get(connectionId) !== generation)
        return this.getState()
      const tunnel = await this.connector.connect(computer, () => undefined, controller.signal)
      await tunnel.stop()
      if (this.#generations.get(connectionId) !== generation) return this.getState()
      this.#testStatus.set(connectionId, { kind: 'passed' })
      const state = await this.getState()
      this.#emit(state)
      return state
    } catch (error) {
      if (this.#generations.get(connectionId) !== generation) return this.getState()
      const failure = normalizeRemoteError(error)
      this.#testStatus.set(connectionId, {
        kind: 'failed',
        code: failure.code,
        message: failure.message
      })
      const state = await this.getState()
      this.#emit(state)
      throw error
    } finally {
      if (this.#controllers.get(connectionId) === controller) {
        this.#controllers.delete(connectionId)
      }
    }
  }

  async disconnect(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    this.#disconnecting.add(connectionId)
    try {
      return await this.#disconnect(connectionId)
    } finally {
      this.#disconnecting.delete(connectionId)
    }
  }

  async #disconnect(connectionId: string): Promise<RemoteConnectionsState> {
    await this.#find(connectionId)
    this.#generations.set(connectionId, (this.#generations.get(connectionId) ?? 0) + 1)
    this.#controllers.get(connectionId)?.abort()
    this.#controllers.delete(connectionId)
    if (this.#testStatus.get(connectionId)?.kind === 'testing') {
      this.#testStatus.set(connectionId, { kind: 'untested' })
    }
    const tunnel = this.#tunnels.get(connectionId)
    if (tunnel !== undefined) await tunnel.stop()
    this.#tunnels.delete(connectionId)
    this.#status.set(connectionId, { kind: 'disconnected' })
    const state = await this.getState()
    this.#emit(state)
    return state
  }

  async remove(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    this.#editing.add(connectionId)
    try {
      return await this.#remove(connectionId)
    } finally {
      this.#editing.delete(connectionId)
    }
  }

  async #remove(connectionId: string): Promise<RemoteConnectionsState> {
    await this.#find(connectionId)
    if (this.#controllers.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer has an operation in progress.'
      )
    }
    if ((this.#status.get(connectionId)?.kind ?? 'disconnected') !== 'disconnected') {
      throw new RemoteConnectionError(
        'remote.connection_not_disconnected',
        'Disconnect the remote computer before removing it.'
      )
    }
    const connections = await this.catalog.remove(connectionId)
    this.#status.delete(connectionId)
    this.#testStatus.delete(connectionId)
    this.#generations.delete(connectionId)
    const state = this.#project(connections)
    this.#emit(state)
    return state
  }

  async update(request: UpdateRemoteConnectionRequest): Promise<RemoteConnectionsState> {
    const id = request.connectionId
    assertConnectionId(id)
    this.#assertNotEditing(id)
    if (this.#controllers.has(id)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer has an operation in progress.'
      )
    }
    this.#editing.add(id)
    try {
      const current = await this.#find(id)
      const changedDestination =
        current.host !== request.host ||
        current.port !== request.port ||
        current.user !== request.user
      if (changedDestination && (this.#status.get(id)?.kind ?? 'disconnected') !== 'disconnected') {
        throw new RemoteConnectionError(
          'remote.connection_not_disconnected',
          'Disconnect before changing SSH parameters.'
        )
      }
      const connections = await this.catalog.update(request)
      if (changedDestination) {
        this.#generations.set(id, (this.#generations.get(id) ?? 0) + 1)
        this.#status.set(id, { kind: 'disconnected' })
        this.#testStatus.set(id, { kind: 'untested' })
      }
      const state = this.#project(connections)
      this.#emit(state)
      return state
    } finally {
      this.#editing.delete(id)
    }
  }

  #assertNotEditing(connectionId: string): void {
    if (this.#editing.has(connectionId) || this.#disconnecting.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer has an operation in progress.'
      )
    }
  }

  async shutdown(): Promise<void> {
    for (const connectionId of this.#generations.keys()) {
      this.#generations.set(connectionId, (this.#generations.get(connectionId) ?? 0) + 1)
    }
    for (const controller of this.#controllers.values()) controller.abort()
    this.#controllers.clear()
    const tunnels = [...this.#tunnels.values()]
    this.#tunnels.clear()
    await Promise.all(tunnels.map((tunnel) => tunnel.stop()))
    this.#status.clear()
    this.#testStatus.clear()
  }

  async #find(connectionId: string): Promise<RemoteComputerView> {
    const computer = (await this.catalog.load()).find(
      (entry) => entry.connectionId === connectionId
    )
    if (computer === undefined) {
      throw new RemoteConnectionError(
        'remote.connection_not_found',
        'Remote computer was not found.'
      )
    }
    return computer
  }

  async #handleTunnelExit(connectionId: string, generation: number): Promise<void> {
    if (this.#generations.get(connectionId) !== generation) return
    const tunnel = this.#tunnels.get(connectionId)
    this.#tunnels.delete(connectionId)
    this.#generations.set(connectionId, generation + 1)
    await tunnel?.stop()
    this.#status.set(connectionId, {
      kind: 'failed',
      code: 'remote.tunnel_failed',
      message: 'The supervised SSH tunnel exited.'
    })
    this.#testStatus.set(connectionId, {
      kind: 'failed',
      code: 'remote.tunnel_failed',
      message: 'The supervised SSH tunnel exited.'
    })
    this.#emit(await this.getState())
  }

  #project(computers: readonly RemoteComputerView[]): RemoteConnectionsState {
    return {
      connections: computers.map((computer) => ({
        ...computer,
        configRevision: remoteConfigRevision(computer),
        status: this.#status.get(computer.connectionId) ?? { kind: 'disconnected' },
        testStatus: this.#testStatus.get(computer.connectionId) ?? { kind: 'untested' }
      }))
    }
  }

  #emit(state: RemoteConnectionsState): void {
    for (const listener of this.#listeners) listener(state)
  }
}

function normalizeRemoteError(error: unknown): {
  readonly code: RemoteConnectionErrorCode
  readonly message: string
} {
  if (error instanceof RemoteConnectionError) return error
  return { code: 'remote.tunnel_failed', message: 'Remote connection failed.' }
}
