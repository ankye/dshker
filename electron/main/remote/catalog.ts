import { randomUUID } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  CreateRemoteConnectionRequest,
  RemoteComputerView
} from '../../../src/shared/contracts'
import { RemoteConnectionError } from './errors'

export const REMOTE_CONNECTIONS_FORMAT = 'dsh-launcher.remote-connections' as const
export const REMOTE_CONNECTIONS_VERSION = 1 as const

interface RemoteConnectionsRecord {
  readonly format: typeof REMOTE_CONNECTIONS_FORMAT
  readonly version: typeof REMOTE_CONNECTIONS_VERSION
  readonly connections: readonly RemoteComputerView[]
}

export interface RemoteConnectionCatalogOptions {
  readonly resolveSettingsRoot: () => Promise<string>
}

/** Strict persistence for stable computer definitions; runtime authority never enters this file. */
export class RemoteConnectionCatalog {
  constructor(private readonly options: RemoteConnectionCatalogOptions) {}

  async load(): Promise<readonly RemoteComputerView[]> {
    const filePath = await this.#filePath()
    return (await loadOrCreate(filePath)).connections
  }

  async create(request: CreateRemoteConnectionRequest): Promise<readonly RemoteComputerView[]> {
    assertCreateRemoteConnectionRequest(request)
    const filePath = await this.#filePath()
    const current = await loadOrCreate(filePath)
    const normalizedName = request.displayName.trim()
    if (
      current.connections.some(
        (connection) =>
          connection.displayName.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
      )
    ) {
      throw new RemoteConnectionError(
        'remote.connection_exists',
        'A remote computer with this display name already exists.'
      )
    }
    const next: RemoteConnectionsRecord = {
      ...current,
      connections: [
        ...current.connections,
        {
          connectionId: randomUUID(),
          displayName: normalizedName,
          host: request.host,
          port: request.port,
          user: request.user
        }
      ]
    }
    await save(filePath, next)
    return next.connections
  }

  async remove(connectionId: string): Promise<readonly RemoteComputerView[]> {
    assertConnectionId(connectionId)
    const filePath = await this.#filePath()
    const current = await loadOrCreate(filePath)
    if (!current.connections.some((connection) => connection.connectionId === connectionId)) {
      throw new RemoteConnectionError(
        'remote.connection_not_found',
        'Remote computer was not found.'
      )
    }
    const next = {
      ...current,
      connections: current.connections.filter(
        (connection) => connection.connectionId !== connectionId
      )
    }
    await save(filePath, next)
    return next.connections
  }

  async #filePath(): Promise<string> {
    const settingsRoot = await this.options.resolveSettingsRoot()
    const launcherDirectory = path.join(settingsRoot, 'dsh-launcher')
    return path.join(launcherDirectory, 'remote-connections.json')
  }
}

export function assertCreateRemoteConnectionRequest(request: CreateRemoteConnectionRequest): void {
  if (!isDisplayName(request.displayName)) {
    throw new RemoteConnectionError('remote.invalid_request', 'Display name is invalid.')
  }
  if (!isSshHost(request.host)) {
    throw new RemoteConnectionError('remote.invalid_request', 'SSH host is invalid.')
  }
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
    throw new RemoteConnectionError('remote.invalid_request', 'SSH port is invalid.')
  }
  if (!isSshUser(request.user)) {
    throw new RemoteConnectionError('remote.invalid_request', 'SSH user is invalid.')
  }
}

export function assertConnectionId(connectionId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId)
  ) {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote connection identity is invalid.'
    )
  }
}

export function parseRemoteConnectionsRecord(text: string): RemoteConnectionsRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new RemoteConnectionError(
      'remote.invalid_record',
      'Remote connection catalog is not valid JSON.',
      { cause: error }
    )
  }
  const record = exactRecord(value, ['format', 'version', 'connections'])
  if (record.format !== REMOTE_CONNECTIONS_FORMAT) {
    throw new RemoteConnectionError(
      'remote.invalid_record',
      'Remote connection catalog format is invalid.'
    )
  }
  if (record.version !== REMOTE_CONNECTIONS_VERSION) {
    throw new RemoteConnectionError(
      'remote.unsupported_version',
      'Remote connection catalog version is unsupported.'
    )
  }
  if (!Array.isArray(record.connections)) {
    throw new RemoteConnectionError(
      'remote.invalid_record',
      'Remote connection catalog entries are invalid.'
    )
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  const connections = record.connections.map((entry) => {
    const computer = exactRecord(entry, ['connectionId', 'displayName', 'host', 'port', 'user'])
    if (
      typeof computer.connectionId !== 'string' ||
      typeof computer.displayName !== 'string' ||
      typeof computer.host !== 'string' ||
      typeof computer.port !== 'number' ||
      typeof computer.user !== 'string'
    ) {
      throw new RemoteConnectionError(
        'remote.invalid_record',
        'Remote computer entry fields are invalid.'
      )
    }
    try {
      assertConnectionId(computer.connectionId)
      assertCreateRemoteConnectionRequest({
        displayName: computer.displayName,
        host: computer.host,
        port: computer.port,
        user: computer.user
      })
    } catch (error) {
      if (error instanceof RemoteConnectionError) {
        throw new RemoteConnectionError(
          'remote.invalid_record',
          'Remote computer entry values are invalid.'
        )
      }
      throw error
    }
    const foldedName = computer.displayName.toLocaleLowerCase()
    if (ids.has(computer.connectionId) || names.has(foldedName)) {
      throw new RemoteConnectionError(
        'remote.invalid_record',
        'Remote computer identities must be unique.'
      )
    }
    ids.add(computer.connectionId)
    names.add(foldedName)
    return {
      connectionId: computer.connectionId,
      displayName: computer.displayName,
      host: computer.host,
      port: computer.port,
      user: computer.user
    }
  })
  return { format: REMOTE_CONNECTIONS_FORMAT, version: REMOTE_CONNECTIONS_VERSION, connections }
}

function isDisplayName(value: string): boolean {
  return (
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 64 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}

function isSshHost(value: string): boolean {
  return /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/u.test(value)
}

function isSshUser(value: string): boolean {
  return /^(?!-)[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u.test(value)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteConnectionError(
      'remote.invalid_record',
      'Remote connection record must be an object.'
    )
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new RemoteConnectionError(
      'remote.invalid_record',
      'Remote connection record fields are invalid.'
    )
  }
  return record
}

function emptyRecord(): RemoteConnectionsRecord {
  return { format: REMOTE_CONNECTIONS_FORMAT, version: REMOTE_CONNECTIONS_VERSION, connections: [] }
}

async function loadOrCreate(filePath: string): Promise<RemoteConnectionsRecord> {
  await assertParent(path.dirname(filePath))
  await assertNotSymlink(filePath)
  try {
    return parseRemoteConnectionsRecord(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const initial = emptyRecord()
    await save(filePath, initial)
    return initial
  }
}

async function save(filePath: string, record: RemoteConnectionsRecord): Promise<void> {
  parseRemoteConnectionsRecord(JSON.stringify(record))
  const parent = path.dirname(filePath)
  await assertParent(parent)
  await assertNotSymlink(filePath)
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new RemoteConnectionError(
      'remote.persistence_failed',
      'Unable to persist remote connection catalog.',
      { cause: error }
    )
  }
  const persisted = parseRemoteConnectionsRecord(await readFile(filePath, 'utf8'))
  if (JSON.stringify(persisted) !== JSON.stringify(record)) {
    throw new RemoteConnectionError(
      'remote.persistence_failed',
      'Remote connection catalog readback differs from the committed record.'
    )
  }
}

async function assertParent(parent: string): Promise<void> {
  try {
    const stats = await lstat(parent)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('invalid directory')
  } catch (error) {
    throw new RemoteConnectionError(
      'remote.persistence_failed',
      'Remote connection settings directory is unavailable.',
      { cause: error }
    )
  }
}

async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new RemoteConnectionError(
        'remote.persistence_failed',
        'Remote connection catalog must not be a symbolic link.'
      )
    }
  } catch (error) {
    if (error instanceof RemoteConnectionError) throw error
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new RemoteConnectionError(
        'remote.persistence_failed',
        'Unable to inspect remote connection catalog.',
        { cause: error }
      )
    }
  }
}
