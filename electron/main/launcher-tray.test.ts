import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  quit: vi.fn(),
  getPath: vi.fn(() => '/nonexistent-user-data'),
  isPackaged: false,
  getAppPath: vi.fn(() => '/app'),
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  createFromPath: vi.fn(() => ({
    resize: vi.fn(() => 'icon'),
    isEmpty: vi.fn(() => false),
    setTemplateImage: vi.fn()
  })),
  createEmpty: vi.fn(() => 'empty-icon'),
  trayThrows: false
}))

vi.mock('electron', () => ({
  app: {
    quit: electronMocks.quit,
    getPath: electronMocks.getPath,
    getAppPath: electronMocks.getAppPath,
    get isPackaged() {
      return electronMocks.isPackaged
    }
  },
  Menu: { buildFromTemplate: electronMocks.buildFromTemplate },
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
    createEmpty: electronMocks.createEmpty
  },
  Tray: class {
    constructor() {
      if (electronMocks.trayThrows) throw new Error('no system tray available')
    }
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    destroy = vi.fn()
    on = vi.fn((event: string, listener: () => void) => {
      trayListeners.set(event, listener)
    })
  }
}))

/** Handlers the tray registered on its own icon, so a click can be replayed. */
const trayListeners = new Map<string, () => void>()

/** One stand-in main window that records how its close event was handled. */
function windowStub() {
  const listeners = new Map<string, (event: { preventDefault: () => void }) => void>()
  const window = {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: (event: { preventDefault: () => void }) => void) => {
      listeners.set(event, listener)
    })
  }
  /** Replays the window's own close button and reports whether it was blocked. */
  const close = (): boolean => {
    let prevented = false
    listeners.get('close')?.({ preventDefault: () => (prevented = true) })
    return prevented
  }
  return { window, close }
}

async function load() {
  vi.resetModules()
  trayListeners.clear()
  return import('./launcher-tray')
}

describe('Launcher tray close behaviour', () => {
  beforeEach(() => {
    electronMocks.quit.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('minimises to tray when the window close button is used', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)

    expect(close()).toBe(true)
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(electronMocks.quit).not.toHaveBeenCalled()
  })

  /**
   * The regression this exists for: Cmd+Q, the application menu, the Dock's Quit
   * item and a termination signal all reach `app.quit()` without passing through
   * the tray, so only the tray used to release the interception. Every other path
   * ran the shutdown and was then cancelled by the window hiding itself, leaving
   * a process with no window, no tray icon and the single-instance lock held.
   */
  it('lets a quit close the window once the quit has been declared', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)

    expect(tray.isForceQuitting()).toBe(false)
    tray.beginForceQuit()
    expect(tray.isForceQuitting()).toBe(true)

    expect(close()).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  /**
   * A left-click shows the window; it must not quit.
   *
   * This test previously asserted the opposite — that clicking the tray icon
   * quits — and so pinned a real hazard as correct: a stray click on the menu
   * bar killed the app with no confirmation, while the tray's own context menu
   * offered a separate "显示" item for the same gesture. Quitting is an explicit
   * menu choice.
   */
  it('shows the window when the tray icon is clicked, without quitting', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)

    trayListeners.get('click')?.()

    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(electronMocks.quit).not.toHaveBeenCalled()
    expect(tray.isForceQuitting()).toBe(false)
    // Minimise-to-tray is still in force, so the close button still hides.
    expect(close()).toBe(true)
  })

  /**
   * A tray that cannot be created must not leave minimise-to-tray in force.
   *
   * `isTrayActive()` gates the `window-all-closed` quit, so a throw from
   * `new Tray()` — no system tray on a bare Linux session, a corrupt icon — left
   * the app with no window, no tray icon and no way to quit at all, still
   * holding the single-instance lock. Falling back to 'quit' keeps the window's
   * close button working as the only remaining exit.
   */
  it('falls back to close-to-quit when the tray cannot be created', async () => {
    electronMocks.trayThrows = true
    try {
      const tray = await load()
      const { window, close } = windowStub()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      expect(() => tray.createTray(window as never)).not.toThrow()

      expect(tray.isTrayActive()).toBe(false)
      expect(close()).toBe(false)
      expect(window.hide).not.toHaveBeenCalled()
      consoleError.mockRestore()
    } finally {
      electronMocks.trayThrows = false
    }
  })

  /**
   * The tray's "退出" item is now the only quit path the tray offers, and it must
   * declare the quit before calling `app.quit()` — otherwise the window's own
   * close handler hides the window and cancels the quit, which is the failure
   * that left an invisible process holding the single-instance lock.
   *
   * Nothing asserted the menu's contents before, so the quit item's wiring was
   * entirely uncovered.
   */
  it('declares the quit before asking the app to quit from the tray menu', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)

    const template = electronMocks.buildFromTemplate.mock.calls.at(-1)?.[0] as {
      label?: string
      click?: () => void
    }[]
    const quitItem = template.find((item) => item.label === '退出')
    expect(quitItem).toBeDefined()

    quitItem?.click?.()

    expect(tray.isForceQuitting()).toBe(true)
    expect(electronMocks.quit).toHaveBeenCalledTimes(1)
    expect(close()).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('closes straight away when the user chose close-to-quit', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)
    tray.setCloseBehavior('quit')

    expect(tray.isTrayActive()).toBe(false)
    expect(close()).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('treats a repeated quit declaration as the same quit', async () => {
    const tray = await load()
    const { window, close } = windowStub()
    tray.createTray(window as never)

    tray.beginForceQuit()
    tray.beginForceQuit()

    expect(tray.isForceQuitting()).toBe(true)
    expect(close()).toBe(false)
  })
})
