// The main-only view of the core's remote route.
//
// The shell used to resolve OpenSSH, transfer the peer descriptor, run two port
// forwards and write the connection catalog itself. The core owns all of that
// now, so this file is the only way the shell reaches it: the catalog operations,
// the live generation, and the broker a remote peer reaches.
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** One catalog entry as the core projects it, with its revision. */
export interface CoreRemoteConnection {
  readonly connectionId: string
  readonly displayName: string
  readonly host: string
  readonly port: number
  readonly user: string
  readonly sshKeyPath?: string
  readonly configRevision: string
}

/** One live generation as the core reports it. */
export interface CoreRemoteStatus {
  readonly url: string
}

/** The route operations the shell performs, wherever they are served. */
export interface CoreRemoteRoutePort {
  inspectCatalog(filePath: string, signal?: AbortSignal): Promise<readonly CoreRemoteConnection[]>
  createConnection(
    request: Readonly<{
      filePath: string
      displayName: string
      host: string
      port: number
      user: string
      sshKeyPath: string
    }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]>
  updateConnection(
    request: Readonly<{
      filePath: string
      connectionId: string
      displayName: string
      host: string
      port: number
      user: string
      sshKeyPath: string
      expectedConfigRevision: string
    }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]>
  removeConnection(
    request: Readonly<{ filePath: string; connectionId: string }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]>
  connect(
    request: Readonly<{
      connectionId: string
      host: string
      port: number
      user: string
      sshKeyPath: string
    }>,
    signal?: AbortSignal
  ): Promise<CoreRemoteStatus>
  disconnect(connectionId: string, signal?: AbortSignal): Promise<void>
  status(connectionId: string, signal?: AbortSignal): Promise<CoreRemoteStatus | undefined>
  startBroker(
    request: Readonly<{ descriptorPath: string; subjectId: string }>,
    signal?: AbortSignal
  ): Promise<Readonly<{ port: number; instanceId: string }>>
  stopBroker(signal?: AbortSignal): Promise<void>
}

const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Projects one core catalog answer through the shape the renderer already reads. */
function connectionsOf(value: unknown): readonly CoreRemoteConnection[] {
  if (!isRecord(value) || !Array.isArray(value.connections)) {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  return value.connections.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.connectionId !== 'string' ||
      typeof entry.displayName !== 'string' ||
      typeof entry.host !== 'string' ||
      typeof entry.port !== 'number' ||
      typeof entry.user !== 'string' ||
      (entry.sshKeyPath !== undefined && typeof entry.sshKeyPath !== 'string') ||
      typeof entry.configRevision !== 'string'
    ) {
      throw new PeerHelperError('p2p.invalid_payload')
    }
    return {
      connectionId: entry.connectionId,
      displayName: entry.displayName,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      sshKeyPath: entry.sshKeyPath ?? '',
      configRevision: entry.configRevision
    }
  })
}

function statusOf(value: unknown): CoreRemoteStatus | undefined {
  if (!isRecord(value) || value.present !== true || typeof value.url !== 'string') return undefined
  return { url: value.url }
}

/** Calls the core's remote.* methods over its private channel. */
export class CoreRemoteRoute implements CoreRemoteRoutePort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async inspectCatalog(
    filePath: string,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]> {
    return connectionsOf(
      await this.#rpc.call('remote.catalog_inspect', { filePath }, budget(signal))
    )
  }

  async createConnection(
    request: Readonly<{
      filePath: string
      displayName: string
      host: string
      port: number
      user: string
    }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]> {
    return connectionsOf(
      await this.#rpc.call('remote.catalog_create', { ...request }, budget(signal))
    )
  }

  async updateConnection(
    request: Readonly<{
      filePath: string
      connectionId: string
      displayName: string
      host: string
      port: number
      user: string
      expectedConfigRevision: string
    }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]> {
    return connectionsOf(
      await this.#rpc.call('remote.catalog_update', { ...request }, budget(signal))
    )
  }

  async removeConnection(
    request: Readonly<{ filePath: string; connectionId: string }>,
    signal?: AbortSignal
  ): Promise<readonly CoreRemoteConnection[]> {
    return connectionsOf(
      await this.#rpc.call('remote.catalog_remove', { ...request }, budget(signal))
    )
  }

  async connect(
    request: Readonly<{
      connectionId: string
      host: string
      port: number
      user: string
      sshKeyPath: string
    }>,
    signal?: AbortSignal
  ): Promise<CoreRemoteStatus> {
    const answer = await this.#rpc.call(
      'remote.connect',
      {
        connectionId: request.connectionId,
        computer: {
          host: request.host,
          port: request.port,
          user: request.user
        },
        ssh: '',
        scp: '',
        sshKeyPath: request.sshKeyPath
      },
      budget(signal)
    )
    if (!isRecord(answer) || typeof answer.url !== 'string') {
      throw new PeerHelperError('p2p.invalid_payload')
    }
    return { url: answer.url }
  }

  async disconnect(connectionId: string, signal?: AbortSignal): Promise<void> {
    await this.#rpc.call('remote.disconnect', { connectionId }, budget(signal))
  }

  async status(connectionId: string, signal?: AbortSignal): Promise<CoreRemoteStatus | undefined> {
    return statusOf(await this.#rpc.call('remote.status', { connectionId }, budget(signal)))
  }

  async startBroker(
    request: Readonly<{ descriptorPath: string; subjectId: string }>,
    signal?: AbortSignal
  ): Promise<Readonly<{ port: number; instanceId: string }>> {
    const answer = await this.#rpc.call('remote.broker_start', { ...request }, budget(signal))
    if (
      !isRecord(answer) ||
      typeof answer.port !== 'number' ||
      typeof answer.instanceId !== 'string'
    ) {
      throw new PeerHelperError('p2p.invalid_payload')
    }
    return { port: answer.port, instanceId: answer.instanceId }
  }

  async stopBroker(signal?: AbortSignal): Promise<void> {
    await this.#rpc.call('remote.broker_stop', {}, budget(signal))
  }
}
