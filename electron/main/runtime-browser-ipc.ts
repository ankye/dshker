import { ipcMain } from 'electron'
import {
  DESKTOP_IPC_CHANNELS,
  apiFail,
  apiOk,
  type ApiResult,
  type RuntimeBrowserHostRenderingInfo,
  type RuntimeBrowserPreferences,
  type SetRuntimeBrowserZoomRequest
} from '../../src/shared/contracts'
import { isRuntimeBrowserZoomPercent } from '../../src/shared/runtime-browser-zoom'
import { ManagedRootError } from './managed/errors'
import { runtimeBrowserFailure, type RuntimeBrowserController } from './runtime-browser-controller'
import { isTrustedRenderer } from './security'

/** Registers the narrow persistence and diagnostics surface for DSH Web guests. */
export function registerRuntimeBrowserIpc(controller: RuntimeBrowserController): void {
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.runtimeBrowserGetPreferences,
    async (event, ...args): Promise<ApiResult<RuntimeBrowserPreferences>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidPayload()
      try {
        return apiOk(await controller.getPreferences())
      } catch (error) {
        return runtimeBrowserFailure(error)
      }
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.runtimeBrowserSetZoom,
    async (event, payload: unknown, ...args): Promise<ApiResult<RuntimeBrowserPreferences>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidPayload()
      let request: SetRuntimeBrowserZoomRequest
      try {
        request = parseRuntimeBrowserZoomRequest(payload)
      } catch (error) {
        return runtimeBrowserFailure(error)
      }
      try {
        return apiOk(await controller.setZoom(request.zoomPercent))
      } catch (error) {
        return runtimeBrowserFailure(error)
      }
    }
  )
  ipcMain.handle(
    DESKTOP_IPC_CHANNELS.runtimeBrowserGetHostRenderingInfo,
    async (event, ...args): Promise<ApiResult<RuntimeBrowserHostRenderingInfo>> => {
      if (!isTrustedRenderer(event)) return invalidSender()
      if (args.length !== 0) return invalidPayload()
      try {
        return apiOk(controller.getHostRenderingInfo(event.sender))
      } catch (error) {
        return runtimeBrowserFailure(error)
      }
    }
  )
}

/** Admits exactly one product-defined zoom percentage and no unknown fields. */
export function parseRuntimeBrowserZoomRequest(payload: unknown): SetRuntimeBrowserZoomRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Runtime browser zoom request is invalid.'
    )
  }
  const record = payload as Record<string, unknown>
  if (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, 'zoomPercent')
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Runtime browser zoom request fields are invalid.'
    )
  }
  if (!isRuntimeBrowserZoomPercent(record.zoomPercent)) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Runtime browser zoom percentage is invalid.'
    )
  }
  return { zoomPercent: record.zoomPercent }
}

function invalidSender<T>(): ApiResult<T> {
  return apiFail('bootstrap.invalid_sender', 'Renderer identity validation failed.')
}

function invalidPayload<T>(): ApiResult<T> {
  return apiFail('managed.selection_invalid', 'Runtime browser request payload is invalid.')
}
