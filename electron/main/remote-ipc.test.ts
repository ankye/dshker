import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../src/shared/contracts'
import type { RemoteConnectionService } from './remote/service'
import {
  parseCreateRemoteConnectionRequest,
  parseUpdateRemoteConnectionRequest,
  registerRemoteConnectionIpc
} from './remote-ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  getAllWindows: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
    )
  }
}))

vi.mock('./security', () => ({ isTrustedRenderer: vi.fn(() => mocks.trusted) }))

function remoteService() {
  let listener: ((state: { connections: readonly [] }) => void) | undefined
  const state = { connections: [] } as const
  return {
    service: {
      getState: vi.fn(async () => state),
      create: vi.fn(async () => state),
      update: vi.fn(async () => state),
      test: vi.fn(async () => state),
      connect: vi.fn(async () => state),
      disconnect: vi.fn(async () => state),
      remove: vi.fn(async () => state),
      onStateChange: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    } as unknown as RemoteConnectionService,
    emit: () => listener?.(state)
  }
}

describe('remote connection IPC', () => {
  it('admits exact versioned updates and rejects authority, missing revisions and untrusted senders', async () => {
    const request = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      expectedConfigRevision: 'a'.repeat(64),
      displayName: 'Mac',
      host: 'mac',
      port: 22,
      user: 'dev'
    }
    expect(parseUpdateRemoteConnectionRequest(request)).toEqual(request)
    for (const field of ['privateKey', 'deviceId', 'pairId', 'mode', 'url', 'targetPort']) {
      expect(() =>
        parseUpdateRemoteConnectionRequest({ ...request, [field]: 'forbidden' })
      ).toThrow()
    }
    expect(() =>
      parseUpdateRemoteConnectionRequest({ ...request, expectedConfigRevision: '' })
    ).toThrow()
    const { service } = remoteService()
    registerRemoteConnectionIpc(service)
    const update = mocks.handlers.get(DESKTOP_IPC_CHANNELS.remoteConnectionsUpdate)!
    mocks.trusted = false
    expect(await update({}, request)).toMatchObject({ ok: false, code: 'remote.invalid_request' })
    expect(service.update).not.toHaveBeenCalled()
    mocks.trusted = true
    expect(await update({}, request, 'extra')).toMatchObject({
      ok: false,
      code: 'remote.invalid_request'
    })
    expect(await update({}, request)).toEqual({ ok: true, data: { connections: [] } })
    expect(service.update).toHaveBeenCalledWith(request)
  })
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.trusted = true
    mocks.getAllWindows.mockReset()
  })

  it('rejects unknown and authority-bearing create fields', () => {
    expect(() =>
      parseCreateRemoteConnectionRequest({
        displayName: 'Mac',
        host: 'mac',
        port: 22,
        user: 'dev',
        privateKey: '/tmp/id'
      })
    ).toThrowError(/fields/u)
    expect(() =>
      parseCreateRemoteConnectionRequest({
        displayName: 'Mac',
        host: 'mac',
        port: '22',
        user: 'dev'
      })
    ).toThrowError(/invalid/u)
  })

  it('admits only named exact operations from the trusted renderer', async () => {
    const { service } = remoteService()
    registerRemoteConnectionIpc(service)
    const create = mocks.handlers.get(DESKTOP_IPC_CHANNELS.remoteConnectionsCreate)!
    expect(await create({}, { displayName: 'Mac', host: 'mac', port: 22, user: 'dev' })).toEqual({
      ok: true,
      data: { connections: [] }
    })
    expect(service.create).toHaveBeenCalledWith({
      displayName: 'Mac',
      host: 'mac',
      port: 22,
      user: 'dev'
    })
    expect(
      await mocks.handlers.get(DESKTOP_IPC_CHANNELS.remoteConnectionsTest)?.(
        {},
        { connectionId: '11111111-1111-4111-8111-111111111111' }
      )
    ).toEqual({ ok: true, data: { connections: [] } })
    expect(service.test).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')

    mocks.trusted = false
    expect(
      await mocks.handlers.get(DESKTOP_IPC_CHANNELS.remoteConnectionsGetState)?.({})
    ).toMatchObject({ ok: false, code: 'remote.invalid_request' })
    expect(service.getState).not.toHaveBeenCalled()
  })

  it('broadcasts catalog and tunnel state only to live windows', () => {
    const liveSend = vi.fn()
    const destroyedSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } }
    ])
    const { service, emit } = remoteService()
    registerRemoteConnectionIpc(service)
    emit()
    expect(liveSend).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.remoteConnectionsStateChanged, {
      ok: true,
      data: { connections: [] }
    })
    expect(destroyedSend).not.toHaveBeenCalled()
  })
})
