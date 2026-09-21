import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The display-change wiring of the launcher window.
 *
 * `window-placement.test.ts` covers the geometry. This file covers the part that
 * actually broke in the field: which events the window subscribes to, and whether the
 * remembered position survives startup. The placement rules were already correct —
 * unplugging a monitor simply never reached them, because only
 * `display-metrics-changed` was subscribed and pulling out a display emits
 * `display-removed`.
 */

const screenListeners = new Map<string, Set<(...args: unknown[]) => void>>()

function emitDisplayEvent(event: string): void {
  for (const listener of screenListeners.get(event) ?? []) listener()
}

const mocks = vi.hoisted(() => ({
  displays: [] as { workArea: { x: number; y: number; width: number; height: number } }[],
  savedFile: undefined as string | undefined,
  savedContent: undefined as string | undefined,
  readContent: undefined as string | undefined,
  windowBounds: { x: 0, y: 0, width: 1240, height: 820 },
  minimized: false,
  fullScreen: false
}))

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), webRequest: { onHeadersReceived: vi.fn() } }
    }
    readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
    setBoundsCalls: Electron.Rectangle[] = []
    showCalls = 0
    restoreCalls = 0
    focusCalls = 0
    constructor(readonly options: Record<string, unknown>) {
      FakeBrowserWindow.instances.push(this)
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? []
      list.push(listener)
      this.handlers.set(event, list)
      return this
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener)
    }
    emit(event: string): void {
      for (const listener of this.handlers.get(event) ?? []) listener()
    }
    getBounds(): Electron.Rectangle {
      return { ...mocks.windowBounds } as Electron.Rectangle
    }
    setBounds(bounds: Electron.Rectangle): void {
      this.setBoundsCalls.push(bounds)
      mocks.windowBounds = { ...bounds }
    }
    show(): void {
      this.showCalls += 1
    }
    restore(): void {
      this.restoreCalls += 1
    }
    focus(): void {
      this.focusCalls += 1
    }
    isDestroyed(): boolean {
      return false
    }
    isMinimized(): boolean {
      return mocks.minimized
    }
    isFullScreen(): boolean {
      return mocks.fullScreen
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    app: {
      getPath: vi.fn(() => '/user-data'),
      getAppPath: vi.fn(() => '/app'),
      isPackaged: true,
      dock: undefined
    },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
    screen: {
      getAllDisplays: vi.fn(() => mocks.displays),
      getPrimaryDisplay: vi.fn(() => mocks.displays[0]),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const set = screenListeners.get(event) ?? new Set()
        set.add(listener)
        screenListeners.set(event, set)
      }),
      off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        screenListeners.get(event)?.delete(listener)
      })
    }
  }
})

vi.mock('node:fs', () => {
  const api = {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(() => {
      if (mocks.readContent === undefined) throw new Error('missing')
      return mocks.readContent
    }),
    writeFileSync: vi.fn((file: string, content: string) => {
      mocks.savedFile = file
      mocks.savedContent = content
    })
  }
  // Other modules in this graph import the default export, so both shapes are served.
  return { ...api, default: api }
})

vi.mock('./preload', () => ({ createPreloadWebPreferences: vi.fn(() => ({})) }))
vi.mock('./security', () => ({
  installWebviewPolicy: vi.fn(),
  installWindowNavigationPolicy: vi.fn()
}))

const laptop = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const externalRight = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }

async function build() {
  const { createWindow } = await import('./window')
  const electron = (await import('electron')) as unknown as {
    BrowserWindow: { instances: { setBoundsCalls: Electron.Rectangle[]; showCalls: number }[] }
  }
  createWindow('/main', {} as never)
  const instances = electron.BrowserWindow.instances
  return instances[instances.length - 1] as unknown as {
    setBoundsCalls: Electron.Rectangle[]
    showCalls: number
    restoreCalls: number
    focusCalls: number
    emit(event: string): void
    options: Record<string, unknown>
  }
}

beforeEach(async () => {
  vi.resetModules()
  screenListeners.clear()
  mocks.displays = [laptop, externalRight]
  mocks.readContent = undefined
  mocks.savedContent = undefined
  mocks.windowBounds = { x: 0, y: 0, width: 1240, height: 820 }
  mocks.minimized = false
  mocks.fullScreen = false
  const electron = (await import('electron')) as unknown as {
    BrowserWindow: { instances: unknown[] }
  }
  electron.BrowserWindow.instances.length = 0
})

afterEach(() => vi.restoreAllMocks())

describe('launcher window display wiring', () => {
  /**
   * The reported bug, as an event-level assertion. Subscribing only to
   * `display-metrics-changed` is what left an unplugged monitor unhandled.
   */
  it('subscribes to display removal and addition, not only to metrics changes', async () => {
    await build()
    expect([...screenListeners.keys()].sort()).toEqual([
      'display-added',
      'display-metrics-changed',
      'display-removed'
    ])
  })

  it('moves a stranded window back when a monitor is unplugged', async () => {
    const window = await build()
    // The window is sitting on the external monitor.
    mocks.windowBounds = { x: 2400, y: 300, width: 1240, height: 820 }

    // The monitor goes away, and only then does the event fire.
    mocks.displays = [laptop]
    emitDisplayEvent('display-removed')

    expect(window.setBoundsCalls.length).toBe(1)
    const placed = window.setBoundsCalls[0]
    expect(placed.x).toBeGreaterThanOrEqual(0)
    expect(placed.x + placed.width).toBeLessThanOrEqual(1920)
  })

  it('leaves a window alone when it is still reachable', async () => {
    const window = await build()
    mocks.windowBounds = { x: 100, y: 100, width: 1240, height: 820 }
    emitDisplayEvent('display-metrics-changed')
    expect(window.setBoundsCalls).toEqual([])
  })

  it('reveals a hidden window when the app is activated from its desktop icon', async () => {
    const { revealWindow } = await import('./window')
    const window = await build()
    mocks.minimized = true

    expect(revealWindow(window as never)).toBe(true)
    expect(window.restoreCalls).toBe(1)
    expect(window.showCalls).toBe(1)
    expect(window.focusCalls).toBe(1)
  })

  /**
   * Moving a minimised window would persist a position the user never chose.
   */
  it('does not reposition a minimised window', async () => {
    const window = await build()
    mocks.windowBounds = { x: 2400, y: 300, width: 1240, height: 820 }
    mocks.minimized = true
    mocks.displays = [laptop]
    emitDisplayEvent('display-removed')
    expect(window.setBoundsCalls).toEqual([])
  })

  /**
   * The second half of the report: reopening the app did not help either. The saved
   * position must be corrected onto a live display instead of being dropped, which
   * previously left `x`/`y` undefined and handed placement to the platform.
   */
  it('clamps a remembered position from a monitor that is now gone', async () => {
    mocks.readContent = JSON.stringify({ x: 2400, y: 300, width: 1240, height: 820 })
    mocks.displays = [laptop]
    const window = await build()
    expect(window.options.x).toBeGreaterThanOrEqual(0)
    expect(window.options.y).toBeGreaterThanOrEqual(0)
    expect(window.options.width).toBe(1240)
    // Position must not be surrendered to the platform.
    expect(window.options.x).not.toBeUndefined()
  })

  /**
   * Startup emits its own move/resize events. Saving those overwrote the position the
   * user chose, which is why a recovered window never came back to its own spot.
   */
  it('does not persist bounds churn before the window is shown', async () => {
    const window = await build()
    window.emit('move')
    window.emit('resize')
    expect(mocks.savedContent).toBeUndefined()

    // Once shown, the geometry is the user's and is worth saving.
    window.emit('ready-to-show')
    mocks.windowBounds = { x: 300, y: 200, width: 1240, height: 820 }
    window.emit('move')
    expect(mocks.savedContent).toBe(JSON.stringify({ x: 300, y: 200, width: 1240, height: 820 }))
  })

  it('corrects placement before showing so the window never appears then jumps', async () => {
    mocks.readContent = JSON.stringify({ x: 2400, y: 300, width: 1240, height: 820 })
    mocks.displays = [laptop]
    const window = await build()
    mocks.windowBounds = { x: 2400, y: 300, width: 1240, height: 820 }
    window.emit('ready-to-show')
    // The correction happened, and it happened while the window was still hidden.
    expect(window.setBoundsCalls.length).toBe(1)
    expect(window.showCalls).toBe(1)
  })

  it('stops listening once the window is closed', async () => {
    await build()
    expect(screenListeners.get('display-removed')?.size).toBe(1)
    const electron = (await import('electron')) as unknown as {
      BrowserWindow: { instances: { emit(event: string): void }[] }
    }
    electron.BrowserWindow.instances[0].emit('closed')
    expect(screenListeners.get('display-removed')?.size).toBe(0)
  })
})
