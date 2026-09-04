import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS } from '../../src/shared/contracts'
import { LauncherUpdateRuntimeError, type LauncherUpdateService } from './launcher-update-service'
import { registerLauncherUpdateIpc } from './launcher-update-ipc'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: true,
  getAllWindows: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    })
  }
}))

vi.mock('./security', () => ({
  isTrustedRenderer: vi.fn(() => mocks.trusted)
}))

function updateService() {
  let listener: ((state: { kind: 'idle'; currentVersion: string }) => void) | undefined
  const state = { kind: 'idle', currentVersion: '0.1.6' } as const
  return {
    service: {
      getState: vi.fn(() => state),
      check: vi.fn(async () => state),
      openInstallerDownload: vi.fn(async () => state),
      onStateChange: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    } as unknown as LauncherUpdateService,
    emit: () => listener?.(state)
  }
}

describe('Launcher update IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.trusted = true
    mocks.getAllWindows.mockReset()
  })

  it('rejects an untrusted sender and every extra argument', async () => {
    const { service } = updateService()
    registerLauncherUpdateIpc(service)
    const channels = [
      DESKTOP_IPC_CHANNELS.launcherUpdatesGetState,
      DESKTOP_IPC_CHANNELS.launcherUpdatesCheck,
      DESKTOP_IPC_CHANNELS.launcherUpdatesOpenInstallerDownload
    ] as const

    mocks.trusted = false
    for (const channel of channels) {
      const handler = mocks.handlers.get(channel)
      expect(handler).toBeDefined()
      expect(await handler?.({})).toMatchObject({
        ok: false,
        code: 'bootstrap.invalid_sender'
      })
    }
    mocks.trusted = true
    for (const channel of channels) {
      expect(await mocks.handlers.get(channel)?.({}, { unexpected: true })).toMatchObject({
        ok: false,
        code: 'launcher.update_invalid_request'
      })
    }
    expect(service.getState).not.toHaveBeenCalled()
    expect(service.check).not.toHaveBeenCalled()
    expect(service.openInstallerDownload).not.toHaveBeenCalled()
  })

  it('admits the three payload-free operations', async () => {
    const { service } = updateService()
    registerLauncherUpdateIpc(service)

    expect(await mocks.handlers.get(DESKTOP_IPC_CHANNELS.launcherUpdatesGetState)?.({})).toEqual({
      ok: true,
      data: { kind: 'idle', currentVersion: '0.1.6' }
    })
    expect(await mocks.handlers.get(DESKTOP_IPC_CHANNELS.launcherUpdatesCheck)?.({})).toEqual({
      ok: true,
      data: { kind: 'idle', currentVersion: '0.1.6' }
    })
    expect(
      await mocks.handlers.get(DESKTOP_IPC_CHANNELS.launcherUpdatesOpenInstallerDownload)?.({})
    ).toEqual({
      ok: true,
      data: { kind: 'idle', currentVersion: '0.1.6' }
    })
  })

  it('sanitizes unavailable installer failures', async () => {
    const { service } = updateService()
    vi.mocked(service.openInstallerDownload).mockRejectedValue(
      new LauncherUpdateRuntimeError(
        'launcher.update_not_available',
        'private detail must not cross IPC'
      )
    )
    registerLauncherUpdateIpc(service)

    await expect(
      mocks.handlers.get(DESKTOP_IPC_CHANNELS.launcherUpdatesOpenInstallerDownload)?.({})
    ).resolves.toEqual({
      ok: false,
      code: 'launcher.update_not_available',
      message: 'No verified Launcher installer is available.'
    })
  })

  it('pushes state only to live Launcher windows', () => {
    const liveSend = vi.fn()
    const destroyedSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } }
    ])
    const { service, emit } = updateService()
    registerLauncherUpdateIpc(service)

    emit()

    expect(liveSend).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.launcherUpdatesStateChanged, {
      ok: true,
      data: { kind: 'idle', currentVersion: '0.1.6' }
    })
    expect(destroyedSend).not.toHaveBeenCalled()
  })
})
