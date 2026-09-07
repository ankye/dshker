import { BrowserWindow, ipcMain } from 'electron'
import {
  DESKTOP_IPC_CHANNELS,
  apiFail,
  apiOk,
  type ApiResult,
  type CreateRemoteConnectionRequest,
  type UpdateRemoteConnectionRequest,
  type RemoteConnectionIdentityRequest,
  type RemoteConnectionsState,
  type RemoteConnectionErrorCode
} from '../../src/shared/contracts'
import { isTrustedRenderer } from './security'
import { RemoteConnectionError } from './remote/errors'
import type { RemoteConnectionService } from './remote/service'

/** Registers only exact remote-computer operations; SSH authority remains in main. */
export function registerRemoteConnectionIpc(service: RemoteConnectionService): void {
  service.onStateChange((state) => {
    const result = apiOk(state)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.remoteConnectionsStateChanged, result)
      }
    }
  })

  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsGetState, (event, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() => service.getState())
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsCreate, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() => service.create(parseCreateRemoteConnectionRequest(payload)))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsTest, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() =>
      service.test(parseRemoteConnectionIdentityRequest(payload).connectionId)
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsUpdate, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() => service.update(parseUpdateRemoteConnectionRequest(payload)))
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsConnect, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() =>
      service.connect(parseRemoteConnectionIdentityRequest(payload).connectionId)
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsDisconnect, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() =>
      service.disconnect(parseRemoteConnectionIdentityRequest(payload).connectionId)
    )
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.remoteConnectionsRemove, (event, payload, ...args) => {
    if (!isTrustedRenderer(event)) return invalidSender()
    if (args.length !== 0) return invalidRequest()
    return remoteResult(() =>
      service.remove(parseRemoteConnectionIdentityRequest(payload).connectionId)
    )
  })
}

export function parseCreateRemoteConnectionRequest(
  payload: unknown
): CreateRemoteConnectionRequest {
  const record = exactRecord(payload, ['displayName', 'host', 'port', 'user'])
  if (
    typeof record.displayName !== 'string' ||
    typeof record.host !== 'string' ||
    typeof record.port !== 'number' ||
    typeof record.user !== 'string'
  )
    throw new RemoteConnectionError('remote.invalid_request', 'Remote computer request is invalid.')
  return {
    displayName: record.displayName,
    host: record.host,
    port: record.port,
    user: record.user
  }
}

export function parseRemoteConnectionIdentityRequest(
  payload: unknown
): RemoteConnectionIdentityRequest {
  const record = exactRecord(payload, ['connectionId'])
  if (typeof record.connectionId !== 'string') {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote connection identity is invalid.'
    )
  }
  return { connectionId: record.connectionId }
}

export function parseUpdateRemoteConnectionRequest(
  payload: unknown
): UpdateRemoteConnectionRequest {
  const record = exactRecord(payload, [
    'connectionId',
    'expectedConfigRevision',
    'displayName',
    'host',
    'port',
    'user'
  ])
  if (
    typeof record.connectionId !== 'string' ||
    typeof record.expectedConfigRevision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.expectedConfigRevision)
  ) {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote configuration revision is invalid.'
    )
  }
  const fields = parseCreateRemoteConnectionRequest({
    displayName: record.displayName,
    host: record.host,
    port: record.port,
    user: record.user
  })
  return {
    ...fields,
    connectionId: record.connectionId,
    expectedConfigRevision: record.expectedConfigRevision
  }
}

async function remoteResult(
  operation: () => Promise<RemoteConnectionsState>
): Promise<ApiResult<RemoteConnectionsState, RemoteConnectionErrorCode>> {
  try {
    return { ok: true, data: await operation() }
  } catch (error) {
    if (error instanceof RemoteConnectionError) return apiFail(error.code, error.message)
    return apiFail('remote.tunnel_failed', 'Remote connection operation failed.')
  }
}

function invalidSender(): ApiResult<RemoteConnectionsState, RemoteConnectionErrorCode> {
  return apiFail(
    'remote.invalid_request',
    'The request was not sent by the active launcher renderer.'
  )
}

function invalidRequest(): ApiResult<RemoteConnectionsState, RemoteConnectionErrorCode> {
  return apiFail('remote.invalid_request', 'Remote connection request is invalid.')
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote connection request must be an object.'
    )
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new RemoteConnectionError(
      'remote.invalid_request',
      'Remote connection request fields are invalid.'
    )
  }
  return record
}
