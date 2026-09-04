import { BrowserWindow, ipcMain } from 'electron'
import {
  DESKTOP_IPC_CHANNELS,
  apiFail,
  apiOk,
  type ApiResult,
  type LauncherUpdateErrorCode,
  type LauncherUpdateState
} from '../../src/shared/contracts'
import { isTrustedRenderer } from './security'
import { LauncherUpdateRuntimeError, type LauncherUpdateService } from './launcher-update-service'

/** Registers the payload-free update discovery and installer-download surface. */
export function registerLauncherUpdateIpc(service: LauncherUpdateService): void {
  service.onStateChange((state) => {
    const result = apiOk(state)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.launcherUpdatesStateChanged, result)
      }
    }
  })

  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherUpdatesGetState,
    (event, ...args): ApiResult<LauncherUpdateState> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidRequest()
      return apiOk(service.getState())
    }
  )

  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherUpdatesCheck,
    async (event, ...args): Promise<ApiResult<LauncherUpdateState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidRequest()
      return apiOk(await service.check())
    }
  )

  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.launcherUpdatesOpenInstallerDownload,
    async (event, ...args): Promise<ApiResult<LauncherUpdateState>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidRequest()
      try {
        return apiOk(await service.openInstallerDownload())
      } catch (error) {
        if (error instanceof LauncherUpdateRuntimeError) {
          return apiFail(error.code, updateFailureMessage(error.code))
        }
        throw error
      }
    }
  )
}

function invalidSender<T>(): ApiResult<T> {
  return apiFail(
    'bootstrap.invalid_sender',
    'The request was not sent by the active launcher renderer.'
  )
}

function invalidRequest<T>(): ApiResult<T, LauncherUpdateErrorCode> {
  return apiFail('launcher.update_invalid_request', 'The Launcher update request is invalid.')
}

function updateFailureMessage(code: LauncherUpdateErrorCode): string {
  if (code === 'launcher.update_not_available') {
    return 'No verified Launcher installer is available.'
  }
  if (code === 'launcher.update_open_failed') {
    return 'The verified Launcher installer could not be opened.'
  }
  return 'The Launcher update operation failed.'
}
