import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { RemoteConnectionError } from './errors'

export const REMOTE_PEER_DESCRIPTOR_FORMAT = 'dsh-launcher.remote-peer' as const
export const REMOTE_PEER_PROTOCOL_VERSION = 1 as const
export const REMOTE_PEER_DESCRIPTOR_RELATIVE_PATH = '.dshlauncher/remote-peer.json' as const

export interface RemotePeerDescriptor {
  readonly format: typeof REMOTE_PEER_DESCRIPTOR_FORMAT
  readonly version: typeof REMOTE_PEER_PROTOCOL_VERSION
  readonly instanceId: string
  readonly port: number
  readonly secret: string
}

export interface RemotePeerBrokerOptions {
  readonly descriptorPath: string
  readonly launcherHarnessService: Pick<LauncherHarnessService, 'getState' | 'start'>
  readonly host?: '127.0.0.1'
}

/** Loopback-only peer endpoint that returns one Launcher-owned DSH session after bearer auth. */
export class RemotePeerBroker {
  readonly #host: '127.0.0.1'
  readonly #descriptorPath: string
  readonly #launcherHarnessService: Pick<LauncherHarnessService, 'getState' | 'start'>
  #server: Server | undefined

  constructor(options: RemotePeerBrokerOptions) {
    this.#host = options.host ?? '127.0.0.1'
    this.#descriptorPath = options.descriptorPath
    this.#launcherHarnessService = options.launcherHarnessService
  }

  async start(): Promise<RemotePeerDescriptor> {
    if (this.#server !== undefined) {
      throw new RemoteConnectionError(
        'remote.connection_busy',
        'Remote peer broker is already running.'
      )
    }
    const secret = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void this.#handle(request, response, secret)
    })
    this.#server = server
    try {
      const port = await listen(server, this.#host)
      const descriptor: RemotePeerDescriptor = {
        format: REMOTE_PEER_DESCRIPTOR_FORMAT,
        version: REMOTE_PEER_PROTOCOL_VERSION,
        instanceId: randomUUID(),
        port,
        secret
      }
      await writeDescriptor(this.#descriptorPath, descriptor)
      return descriptor
    } catch (error) {
      await closeServer(server)
      this.#server = undefined
      throw new RemoteConnectionError(
        'remote.peer_unavailable',
        'Remote peer broker could not start.',
        { cause: error }
      )
    }
  }

  async shutdown(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    await rm(this.#descriptorPath, { force: true })
    if (server !== undefined) await closeServer(server)
  }

  async #handle(request: IncomingMessage, response: ServerResponse, secret: string): Promise<void> {
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'peer_not_loopback' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/runtime/connect') {
      sendJson(response, 404, { error: 'peer_route_not_found' })
      return
    }
    if (!matchesBearer(request.headers.authorization, secret)) {
      sendJson(response, 401, { error: 'peer_authentication_failed' })
      return
    }
    try {
      const url = await connectRuntime(this.#launcherHarnessService)
      sendJson(response, 200, { version: REMOTE_PEER_PROTOCOL_VERSION, url })
    } catch {
      sendJson(response, 503, { error: 'runtime_unavailable' })
    }
  }
}

/** Strict parser shared by SCP intake and unit tests. */
export function parseRemotePeerDescriptor(text: string): RemotePeerDescriptor {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer descriptor is not valid JSON.',
      { cause: error }
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer descriptor must be an object.'
    )
  }
  const record = value as Record<string, unknown>
  const expected = ['format', 'version', 'instanceId', 'port', 'secret']
  const actual = Object.keys(record)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer descriptor fields are invalid.'
    )
  }
  if (record.format !== REMOTE_PEER_DESCRIPTOR_FORMAT) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer descriptor format is invalid.'
    )
  }
  if (record.version !== REMOTE_PEER_PROTOCOL_VERSION) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer protocol version is unsupported.'
    )
  }
  if (
    typeof record.instanceId !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(record.instanceId) ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65_535 ||
    typeof record.secret !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.secret)
  ) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote peer descriptor values are invalid.'
    )
  }
  return {
    format: REMOTE_PEER_DESCRIPTOR_FORMAT,
    version: REMOTE_PEER_PROTOCOL_VERSION,
    instanceId: record.instanceId,
    port: record.port,
    secret: record.secret
  }
}

async function connectRuntime(
  service: Pick<LauncherHarnessService, 'getState' | 'start'>
): Promise<string> {
  const current = await service.getState()
  if (current.launch.kind === 'running') return current.launch.url
  if (current.launch.kind === 'stopped' || current.launch.kind === 'failed') {
    const started = await service.start()
    if (started.launch.kind === 'running') return started.launch.url
    throw new Error('DSH runtime did not announce readiness.')
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    const state = await service.getState()
    if (state.launch.kind === 'running') return state.launch.url
    if (state.launch.kind === 'failed' || state.launch.kind === 'stopped') break
  }
  throw new Error('DSH runtime did not become ready.')
}

function matchesBearer(header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const candidate = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(secret)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function listen(server: Server, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, host, () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Remote peer broker did not bind a TCP port.'))
        return
      }
      resolve(address.port)
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

async function writeDescriptor(filePath: string, descriptor: RemotePeerDescriptor): Promise<void> {
  parseRemotePeerDescriptor(JSON.stringify(descriptor))
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  )
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
