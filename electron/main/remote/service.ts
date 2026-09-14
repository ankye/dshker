// The shell's remote-connection projection.
//
// The core owns everything this page used to do itself: the persisted catalog,
// the OpenSSH resolution, the descriptor transfer, the two port forwards and the
// broker a remote peer reaches. This service is the typed proxy over those
// operations plus the renderer's own view state, so the page keeps the exact
// shape it renders today.
import type {
  CreateRemoteConnectionRequest,
  UpdateRemoteConnectionRequest,
  RemoteConnectionErrorCode,
  RemoteConnectionStatus,
  RemoteConnectionsState,
  RemoteConnectionTestStatus
} from '../../../src/shared/contracts'
import type { CoreRemoteConnection, CoreRemoteRoutePort } from '../core/remote-route'
import { RemoteConnectionError } from './errors'

type StateListener = (state: RemoteConnectionsState) => void

/** Coordinates the core's catalog and generations with the page's view state. */
export class RemoteConnectionService {
  readonly #status = new Map<string, RemoteConnectionStatus>()
  readonly #testStatus = new Map<string, RemoteConnectionTestStatus>()
  readonly #listeners = new Set<StateListener>()
  readonly #editing = new Set<string>()
  readonly #busy = new Set<string>()
  readonly #disconnecting = new Set<string>()

  constructor(
    /** Resolves the catalog document the core owns below the Settings root. */
    private readonly filePath: () => Promise<string>,
    /** The core's route, or undefined on a shell that could not start one. */
    private readonly route: () => CoreRemoteRoutePort | undefined
  ) {}

  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async getState(): Promise<RemoteConnectionsState> {
    return this.#project(await this.#connections())
  }

  async create(request: CreateRemoteConnectionRequest): Promise<RemoteConnectionsState> {
    const { port, filePath } = await this.#core()
    const connections = await port.createConnection({
      filePath,
      displayName: request.displayName,
      host: request.host,
      port: request.port,
      user: request.user
    })
    const state = this.#project(connections)
    this.#emit(state)
    return state
  }

  async connect(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    const current = this.#status.get(connectionId)?.kind ?? 'disconnected'
    if (current === 'connecting' || current === 'ready' || this.#busy.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer is already connecting or ready.'
      )
    }
    const { port, filePath } = await this.#core()
    const computer = await this.#find(connectionId, port, filePath)
    this.#busy.add(connectionId)
    this.#status.set(connectionId, { kind: 'connecting' })
    this.#emit(await this.getState())
    try {
      const live = await port.connect({
        connectionId,
        host: computer.host,
        port: computer.port,
        user: computer.user
      })
      this.#status.set(connectionId, { kind: 'ready', url: live.url })
      this.#testStatus.set(connectionId, { kind: 'passed' })
      const state = await this.getState()
      this.#emit(state)
      return state
    } catch (error) {
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
      throw error
    } finally {
      this.#busy.delete(connectionId)
    }
  }

  /** Proves one definition by opening a generation and closing it again. */
  async test(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    const current = this.#status.get(connectionId)?.kind ?? 'disconnected'
    if (current === 'connecting' || current === 'ready' || this.#busy.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer is connecting, connected, or already being tested.'
      )
    }
    const { port, filePath } = await this.#core()
    const computer = await this.#find(connectionId, port, filePath)
    this.#busy.add(connectionId)
    this.#testStatus.set(connectionId, { kind: 'testing' })
    this.#emit(await this.getState())
    try {
      await port.connect({
        connectionId,
        host: computer.host,
        port: computer.port,
        user: computer.user
      })
      await port.disconnect(connectionId)
      this.#testStatus.set(connectionId, { kind: 'passed' })
      const state = await this.getState()
      this.#emit(state)
      return state
    } catch (error) {
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
      this.#busy.delete(connectionId)
    }
  }

  async disconnect(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    this.#disconnecting.add(connectionId)
    try {
      const { port, filePath } = await this.#core()
      await this.#find(connectionId, port, filePath)
      try {
        await port.disconnect(connectionId)
      } catch (error) {
        // Disconnecting something that is not connected is not a failure: the
        // page only offers the action while it shows a live generation, and a
        // shutdown path may run after the core already dropped it.
        if (!isNotConnected(error)) throw error
      }
      this.#status.set(connectionId, { kind: 'disconnected' })
      if (this.#testStatus.get(connectionId)?.kind === 'testing') {
        this.#testStatus.set(connectionId, { kind: 'untested' })
      }
      const state = await this.getState()
      this.#emit(state)
      return state
    } finally {
      this.#disconnecting.delete(connectionId)
    }
  }

  async update(request: UpdateRemoteConnectionRequest): Promise<RemoteConnectionsState> {
    const connectionId = request.connectionId
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    this.#editing.add(connectionId)
    try {
      const { port, filePath } = await this.#core()
      const computer = await this.#find(connectionId, port, filePath)
      const changedDestination =
        computer.host !== request.host ||
        computer.port !== request.port ||
        computer.user !== request.user
      if (
        changedDestination &&
        (this.#status.get(connectionId)?.kind ?? 'disconnected') !== 'disconnected'
      ) {
        throw new RemoteConnectionError(
          'remote.connection_not_disconnected',
          'Disconnect before changing SSH parameters.'
        )
      }
      const connections = await port.updateConnection({
        filePath,
        connectionId,
        displayName: request.displayName,
        host: request.host,
        port: request.port,
        user: request.user,
        expectedConfigRevision: request.expectedConfigRevision
      })
      if (changedDestination) {
        this.#status.set(connectionId, { kind: 'disconnected' })
        this.#testStatus.set(connectionId, { kind: 'untested' })
      }
      const state = this.#project(connections)
      this.#emit(state)
      return state
    } finally {
      this.#editing.delete(connectionId)
    }
  }

  async remove(connectionId: string): Promise<RemoteConnectionsState> {
    assertConnectionId(connectionId)
    this.#assertNotEditing(connectionId)
    this.#editing.add(connectionId)
    try {
      const { port, filePath } = await this.#core()
      await this.#find(connectionId, port, filePath)
      if (this.#busy.has(connectionId)) {
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
      const connections = await port.removeConnection({ filePath, connectionId })
      this.#status.delete(connectionId)
      this.#testStatus.delete(connectionId)
      const state = this.#project(connections)
      this.#emit(state)
      return state
    } finally {
      this.#editing.delete(connectionId)
    }
  }

  /** Stops every generation this shell opened before the process exits. */
  async shutdown(): Promise<void> {
    const port = this.route()
    if (port !== undefined) {
      for (const connectionId of [...this.#status.keys()]) {
        const kind = this.#status.get(connectionId)?.kind
        if (kind !== 'ready' && kind !== 'connecting') continue
        try {
          await port.disconnect(connectionId)
        } catch {
          // Shutdown must not fail on a core that is already gone.
        }
      }
    }
    this.#status.clear()
    this.#testStatus.clear()
  }

  #assertNotEditing(connectionId: string): void {
    if (this.#editing.has(connectionId) || this.#disconnecting.has(connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote computer has an operation in progress.'
      )
    }
  }

  /** Resolves the core's route and the document it owns. */
  async #core(): Promise<Readonly<{ port: CoreRemoteRoutePort; filePath: string }>> {
    const port = this.route()
    if (port === undefined) {
      throw new RemoteConnectionError(
        'remote.persistence_failed',
        'The headless core is required to read or write remote connections.'
      )
    }
    return { port, filePath: await this.filePath() }
  }

  /**
   * Reads the catalog and mirrors the generations the core reports.
   *
   * The core is the only place a generation lives, so the page's live state is
   * whatever the core says it is: a connection that is no longer live becomes
   * disconnected here without the shell keeping its own idea of the tunnel.
   */
  async #connections(): Promise<readonly CoreRemoteConnection[]> {
    const { port, filePath } = await this.#core()
    const connections = await port.inspectCatalog(filePath)
    for (const connection of connections) {
      const live = await port.status(connection.connectionId).catch(() => undefined)
      if (live === undefined) {
        if (this.#status.get(connection.connectionId)?.kind === 'ready') {
          this.#status.set(connection.connectionId, { kind: 'disconnected' })
        }
        continue
      }
      this.#status.set(connection.connectionId, { kind: 'ready', url: live.url })
    }
    return connections
  }

  async #find(
    connectionId: string,
    port: CoreRemoteRoutePort,
    filePath: string
  ): Promise<CoreRemoteConnection> {
    const computer = (await port.inspectCatalog(filePath)).find(
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

  #project(computers: readonly CoreRemoteConnection[]): RemoteConnectionsState {
    return {
      connections: computers.map((computer) => ({
        connectionId: computer.connectionId,
        displayName: computer.displayName,
        host: computer.host,
        port: computer.port,
        user: computer.user,
        configRevision: computer.configRevision,
        status: this.#status.get(computer.connectionId) ?? { kind: 'disconnected' },
        testStatus: this.#testStatus.get(computer.connectionId) ?? { kind: 'untested' }
      }))
    }
  }

  #emit(state: RemoteConnectionsState): void {
    for (const listener of this.#listeners) listener(state)
  }
}

/** The identity grammar the catalog and the page share. */
function assertConnectionId(connectionId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId)
  ) {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote connection identity is invalid.'
    )
  }
}

function isNotConnected(error: unknown): boolean {
  if (error instanceof RemoteConnectionError) return error.code === 'remote.connection_not_found'
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code: unknown }).code === 'remote.connection_not_found'
  }
  return false
}

function normalizeRemoteError(error: unknown): {
  readonly code: RemoteConnectionErrorCode
  readonly message: string
} {
  if (error instanceof RemoteConnectionError) return error
  return { code: 'remote.tunnel_failed', message: 'Remote connection failed.' }
}
