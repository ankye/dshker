import { app, BrowserWindow, screen, type Input, type WebContents } from 'electron'
import {
  DESKTOP_IPC_CHANNELS,
  apiFail,
  apiOk,
  type ApiResult,
  type RuntimeBrowserHostRenderingInfo,
  type RuntimeBrowserPreferences,
  type RuntimeBrowserZoomPercent
} from '../../src/shared/contracts'
import {
  nextRuntimeBrowserZoom,
  runtimeBrowserZoomCommandForInput
} from '../../src/shared/runtime-browser-zoom'
import { ManagedRootError } from './managed/errors'
import { type RuntimeBrowserPreferencesStore } from './runtime-browser-preferences'

/** Electron guest methods used by the constrained runtime-browser coordinator. */
export type RuntimeBrowserGuest = Pick<
  WebContents,
  'id' | 'isDestroyed' | 'on' | 'once' | 'setZoomFactor'
>

/** Owns one persisted page zoom and applies it to every attached DSH Web guest. */
export class RuntimeBrowserController {
  readonly #preferences: RuntimeBrowserPreferencesStore
  readonly #guests = new Set<RuntimeBrowserGuest>()
  readonly #hosts = new Set<WebContents>()
  #preferenceMutation: Promise<unknown> = Promise.resolve()

  constructor(preferences: RuntimeBrowserPreferencesStore) {
    this.#preferences = preferences
  }

  /** Reads or explicitly creates the strict Launcher-owned browser preferences. */
  getPreferences(): Promise<RuntimeBrowserPreferences> {
    return this.#preferences.load()
  }

  /** Persists one fixed page-zoom step and applies it to every live guest. */
  setZoom(zoomPercent: RuntimeBrowserZoomPercent): Promise<RuntimeBrowserPreferences> {
    return this.#mutate(async () => {
      const preferences = await this.#preferences.setZoom(zoomPercent)
      this.#applyToGuests(preferences)
      this.#broadcast(apiOk(preferences))
      return preferences
    })
  }

  /**
   * Registers a loopback guest after the security policy admitted it.
   *
   * Zoom is applied at attach time, before the page's first completed paint.
   * Browser shortcuts are handled here because key input focused inside a
   * `<webview>` does not bubble to the Launcher renderer.
   */
  attach(host: WebContents, guest: RuntimeBrowserGuest): void {
    if (!this.#hosts.has(host)) {
      this.#hosts.add(host)
      host.once('destroyed', () => this.#hosts.delete(host))
    }
    this.#guests.add(guest)
    guest.once('destroyed', () => this.#guests.delete(guest))
    guest.on('before-input-event', (event, input: Input) => {
      const command = runtimeBrowserZoomCommandForInput(input, process.platform)
      if (command === undefined) return
      event.preventDefault()
      void this.#adjustZoom(command).catch((error: unknown) => {
        this.#broadcast(runtimeBrowserFailure<RuntimeBrowserPreferences>(error))
      })
    })
    void this.#preferences
      .load()
      .then((preferences) => {
        if (!guest.isDestroyed()) guest.setZoomFactor(preferences.zoomPercent / 100)
      })
      .catch((error: unknown) => {
        this.#send(host, runtimeBrowserFailure<RuntimeBrowserPreferences>(error))
      })
  }

  /** Returns rendering facts for the display currently containing the trusted host window. */
  getHostRenderingInfo(host: WebContents): RuntimeBrowserHostRenderingInfo {
    const owner = BrowserWindow.fromWebContents(host)
    if (owner === null) {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Runtime browser host window is unavailable.'
      )
    }
    const electronVersion = process.versions.electron
    const chromiumVersion = process.versions.chrome
    if (electronVersion === undefined || chromiumVersion === undefined) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'Electron rendering version information is unavailable.'
      )
    }
    const display = screen.getDisplayMatching(owner.getBounds())
    const gpu = app.getGPUFeatureStatus()
    return {
      electronVersion,
      chromiumVersion,
      displayScaleFactor: display.scaleFactor,
      displayColorSpace: display.colorSpace,
      gpuCompositing: gpu.gpu_compositing,
      rasterization: gpu.rasterization,
      multipleRasterThreads: gpu.multiple_raster_threads
    }
  }

  async #adjustZoom(
    command: Parameters<typeof nextRuntimeBrowserZoom>[1]
  ): Promise<RuntimeBrowserPreferences> {
    return this.#mutate(async () => {
      const current = await this.#preferences.load()
      const zoomPercent = nextRuntimeBrowserZoom(current.zoomPercent, command)
      const preferences =
        zoomPercent === current.zoomPercent ? current : await this.#preferences.setZoom(zoomPercent)
      this.#applyToGuests(preferences)
      this.#broadcast(apiOk(preferences))
      return preferences
    })
  }

  #applyToGuests(preferences: RuntimeBrowserPreferences): void {
    for (const guest of this.#guests) {
      if (guest.isDestroyed()) {
        this.#guests.delete(guest)
        continue
      }
      guest.setZoomFactor(preferences.zoomPercent / 100)
    }
  }

  #broadcast(result: ApiResult<RuntimeBrowserPreferences>): void {
    for (const host of this.#hosts) {
      if (host.isDestroyed()) {
        this.#hosts.delete(host)
        continue
      }
      this.#send(host, result)
    }
  }

  #send(host: WebContents, result: ApiResult<RuntimeBrowserPreferences>): void {
    host.send(DESKTOP_IPC_CHANNELS.runtimeBrowserZoomChanged, result)
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#preferenceMutation.then(operation, operation)
    this.#preferenceMutation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/** Converts a main-process preference failure to a renderer-safe typed result. */
export function runtimeBrowserFailure<T>(error: unknown): ApiResult<T> {
  if (error instanceof ManagedRootError) return apiFail(error.code, error.message)
  return apiFail(
    'managed.persistence_failed',
    error instanceof Error ? error.message : 'Runtime browser preference operation failed.'
  )
}
