import { app, Menu, nativeImage, Tray } from 'electron'
import nodePath from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'

export type CloseBehavior = 'minimize-to-tray' | 'quit'

interface TrayPreferences {
  closeBehavior: CloseBehavior
}

export interface TrayOptions {
  /**
   * Returns true when the window must stay alive because a main-process task
   * owns Git, dependency installation, or a build. Close is then prevented even
   * if the user's ordinary close preference is "quit"; without a tray, the window
   * stays visible.
   */
  readonly shouldMinimizeOnClose?: () => boolean
}

const PREFS_FILE = 'launcher-tray-preferences.json'
const DEFAULT: CloseBehavior = 'minimize-to-tray'

let tray: Tray | undefined
let mainWindow: BrowserWindow | undefined
let currentBehavior: CloseBehavior = DEFAULT
let preferencesLoaded = false
const closeHandlerWindows = new WeakSet<BrowserWindow>()
/**
 * Set before any deliberate quit so the window close handler lets it through
 * instead of hiding the window — without this flag the quit is caught by the
 * minimise-to-tray handler, the window stays open, the app never exits, and the
 * single-instance lock keeps a relaunch from working.
 *
 * Every quit path must set it, not only the tray: Cmd+Q, the application menu,
 * the Dock's Quit item and a termination signal all reach `app.quit()` without
 * passing through this module, and each of them used to be swallowed by the
 * close handler. `beginForceQuit` is what the main process calls from its
 * `before-quit` handler so one flag covers all of them.
 */
let forceQuitting = false

function prefsPath(): string {
  return nodePath.join(app.getPath('userData'), PREFS_FILE)
}

function read(): CloseBehavior {
  try {
    const raw = readFileSync(prefsPath(), 'utf8')
    const parsed = JSON.parse(raw) as TrayPreferences
    return parsed.closeBehavior === 'minimize-to-tray' || parsed.closeBehavior === 'quit'
      ? parsed.closeBehavior
      : DEFAULT
  } catch {
    return DEFAULT
  }
}

function persist(value: CloseBehavior): void {
  try {
    writeFileSync(prefsPath(), JSON.stringify({ closeBehavior: value } as TrayPreferences), 'utf8')
  } catch {
    /* best-effort */
  }
}

/** Returns the current close behaviour. */
export function getCloseBehavior(): CloseBehavior {
  return currentBehavior
}

/** Sets the close behaviour and persists it. */
export function setCloseBehavior(value: CloseBehavior): void {
  currentBehavior = value
  persist(value)
  rebuildContextMenu()
}

/** True when the window close button minimises to tray instead of quitting. */
export function isTrayActive(): boolean {
  return tray !== undefined && currentBehavior === 'minimize-to-tray'
}

/**
 * Releases the minimise-to-tray close interception for a quit that is already
 * under way.
 *
 * Called from the main process's `before-quit` handler so every quit path —
 * Cmd+Q, the application menu, the Dock, a termination signal, the tray — stops
 * the window from being hidden instead of closed. Idempotent: a quit that is
 * retried or arrives from two sources at once only re-asserts the same flag.
 */
export function beginForceQuit(): void {
  forceQuitting = true
}

/** True once a deliberate quit has released the close interception. */
export function isForceQuitting(): boolean {
  return forceQuitting
}

/**
 * Resolves the menu-bar/tray image.
 *
 * macOS wants a *template* image: a black-and-alpha glyph the system recolours
 * for the light or dark menu bar and inverts when highlighted. The app icon
 * cannot serve that purpose — `icon-512.png` is full-bleed artwork that is 96%
 * opaque with a mid-grey average, so downscaled to 16px it rendered as an
 * unreadable grey square, indistinguishable from no icon at all.
 * `trayTemplate.png` is a dedicated 16px glyph; Electron picks up the `@2x`
 * variant beside it automatically for Retina.
 *
 * Windows and Linux have no template convention and draw the image as-is, so
 * they keep using the coloured app icon.
 */
function trayIcon(): Electron.NativeImage {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'icon-512.png'
  const iconPath = app.isPackaged
    ? nodePath.join(process.resourcesPath, file)
    : nodePath.join(app.getAppPath(), 'resources', file)
  if (!existsSync(iconPath)) return nativeImage.createEmpty()
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return nativeImage.createEmpty()
  if (process.platform === 'darwin') {
    // Already 16px, and resizing would resample the glyph and blur it.
    image.setTemplateImage(true)
    return image
  }
  return image.resize({ width: 16, height: 16 })
}

/** Shows and focuses the window the tray owns. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Creates the system tray icon once and binds lifecycle handling to each window. */
export function createTray(window: BrowserWindow, options: TrayOptions = {}): void {
  mainWindow = window
  if (!preferencesLoaded) {
    currentBehavior = read()
    preferencesLoaded = true
  }

  if (!tray) {
    let candidate: Tray | undefined
    try {
      candidate = new Tray(trayIcon())
      candidate.setToolTip('DSHKer Launcher')
      // Left-click shows the window. It used to quit outright, so a stray click on
      // the menu bar killed the app with no confirmation — and it contradicted this
      // same tray's own "显示" item. Quitting stays an explicit menu choice.
      candidate.on('click', () => showWindow())
      tray = candidate
      rebuildContextMenu()
    } catch (error) {
      candidate?.destroy()
      tray = undefined
      console.error('DSHKer Launcher could not create the system tray icon.', error)
    }
  }

  if (!closeHandlerWindows.has(window)) {
    closeHandlerWindows.add(window)
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = undefined
    })
    window.on('close', (event) => {
      if (forceQuitting) return

      const operationActive = options.shouldMinimizeOnClose?.() === true
      const minimizeToTray = currentBehavior === 'minimize-to-tray' && tray !== undefined
      if (operationActive || minimizeToTray) {
        event.preventDefault()
        // Keep the window visible when tray creation failed. Hiding it would
        // remove the only way to observe and recover the still-running task.
        if (tray) window.hide()
      }
    })
  }
}

/** Destroys the tray icon. Call during shutdown. */
export function destroyTray(): void {
  tray?.destroy()
  tray = undefined
}

/** Quits the app from the tray (icon click or context menu). */
function quitApp(): void {
  beginForceQuit()
  app.quit()
}

function rebuildContextMenu(): void {
  if (!tray) return
  const toggleLabel =
    currentBehavior === 'minimize-to-tray' ? '关闭时直接退出' : '关闭时最小化到托盘'
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 DSHKer Launcher',
        click: () => showWindow()
      },
      {
        label: toggleLabel,
        click: () =>
          setCloseBehavior(currentBehavior === 'minimize-to-tray' ? 'quit' : 'minimize-to-tray')
      },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() }
    ])
  )
}
