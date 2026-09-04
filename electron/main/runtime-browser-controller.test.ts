import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC_CHANNELS, apiOk } from '../../src/shared/contracts'
import { RuntimeBrowserController } from './runtime-browser-controller'
import type { RuntimeBrowserPreferencesStore } from './runtime-browser-preferences'

const electronMocks = vi.hoisted(() => ({
  getGPUFeatureStatus: vi.fn(() => ({
    gpu_compositing: 'enabled',
    rasterization: 'enabled',
    multiple_raster_threads: 'enabled_on'
  })),
  fromWebContents: vi.fn(),
  getDisplayMatching: vi.fn(() => ({ scaleFactor: 2, colorSpace: 'Display P3' }))
}))

vi.mock('electron', () => ({
  app: { getGPUFeatureStatus: electronMocks.getGPUFeatureStatus },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  screen: { getDisplayMatching: electronMocks.getDisplayMatching }
}))

function preferenceStore(initial = 100) {
  let zoomPercent = initial
  return {
    load: vi.fn(async () => ({ zoomPercent })),
    setZoom: vi.fn(async (next: number) => {
      zoomPercent = next
      return { zoomPercent }
    })
  } as unknown as RuntimeBrowserPreferencesStore & {
    load: ReturnType<typeof vi.fn>
    setZoom: ReturnType<typeof vi.fn>
  }
}

function attachedContents() {
  const guestListeners = new Map<string, (...args: never[]) => void>()
  const host = {
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn()
  }
  const guest = {
    id: 7,
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      guestListeners.set(event, listener)
      return guest
    }),
    once: vi.fn(),
    setZoomFactor: vi.fn()
  }
  return { host, guest, guestListeners }
}

describe('RuntimeBrowserController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('applies persisted zoom immediately when a guest attaches', async () => {
    const store = preferenceStore(125)
    const controller = new RuntimeBrowserController(store)
    const { host, guest } = attachedContents()

    controller.attach(host as never, guest as never)
    await vi.waitFor(() => expect(guest.setZoomFactor).toHaveBeenCalledWith(1.25))
  })

  it('handles the platform browser shortcut inside the focused guest and notifies the host', async () => {
    const store = preferenceStore(100)
    const controller = new RuntimeBrowserController(store)
    const { host, guest, guestListeners } = attachedContents()
    controller.attach(host as never, guest as never)
    await vi.waitFor(() => expect(guest.setZoomFactor).toHaveBeenCalledWith(1))
    const preventDefault = vi.fn()
    const modifier =
      process.platform === 'darwin'
        ? { meta: true, control: false }
        : { meta: false, control: true }

    guestListeners.get('before-input-event')?.(
      { preventDefault } as never,
      {
        type: 'keyDown',
        key: '=',
        code: 'Equal',
        isComposing: false,
        alt: false,
        shift: false,
        isAutoRepeat: false,
        location: 0,
        modifiers: [],
        ...modifier
      } as never
    )

    await vi.waitFor(() => expect(store.setZoom).toHaveBeenCalledWith(110))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(guest.setZoomFactor).toHaveBeenLastCalledWith(1.1)
    expect(host.send).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.runtimeBrowserZoomChanged,
      apiOk({ zoomPercent: 110 })
    )
  })

  it('reports display and GPU facts without a display or device identity', () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, electron: '42.4.0', chrome: '148.0.7778.254' }
    })
    const store = preferenceStore()
    const controller = new RuntimeBrowserController(store)
    const host = {} as never
    electronMocks.fromWebContents.mockReturnValue({
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 })
    })

    expect(controller.getHostRenderingInfo(host)).toMatchObject({
      displayScaleFactor: 2,
      displayColorSpace: 'Display P3',
      gpuCompositing: 'enabled',
      rasterization: 'enabled',
      multipleRasterThreads: 'enabled_on'
    })
  })
})
