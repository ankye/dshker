import { BrowserWindow, app, nativeImage, screen } from 'electron'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import nodePath from 'node:path'
import { APP_METADATA } from '../../src/shared/contracts'
import { createPreloadWebPreferences } from './preload'
import { installWebviewPolicy, installWindowNavigationPolicy } from './security'
import { type RuntimeBrowserController } from './runtime-browser-controller'

/** Persisted window bounds, written on every move or resize. */
interface SavedWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_WIDTH = 1240
const DEFAULT_HEIGHT = 820

/**
 * Reads the saved window bounds from `userData`, discarding anything that sits
 * entirely outside every available display (a monitor that was disconnected, an
 * RDP session whose resolution changed).
 */
function loadWindowBounds(): Partial<Electron.Rectangle> {
  try {
    const file = nodePath.join(app.getPath('userData'), 'launcher-window-state.json')
    const raw = readFileSync(file, 'utf8')
    const saved = JSON.parse(raw) as SavedWindowBounds
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return {}
    const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    // At least one display must contain a meaningful part of the window.
    const visible = screen.getAllDisplays().some((display) => {
      const { x, y, width, height } = display.workArea
      return (
        rect.x + rect.width > x &&
        rect.x < x + width &&
        rect.y + rect.height > y &&
        rect.y < y + height
      )
    })
    return visible ? rect : {}
  } catch {
    return {}
  }
}

/** Persists the window's current bounds so they survive a restart. */
function saveWindowBounds(window: ElectronBrowserWindow): void {
  try {
    const bounds = window.getBounds()
    const file = nodePath.join(app.getPath('userData'), 'launcher-window-state.json')
    const dir = nodePath.dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }), 'utf8')
  } catch {
    // Best-effort: a failed write must not interfere with the window itself.
  }
}

/**
 * Brings a window back onto a visible display when the display configuration
 * changed (an external monitor was disconnected, or an RDP session ended).
 */
function ensureOnScreen(window: ElectronBrowserWindow): void {
  const bounds = window.getBounds()
  const onScreen = screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea
    return (
      bounds.x + bounds.width > x &&
      bounds.x < x + width &&
      bounds.y + bounds.height > y &&
      bounds.y < y + height
    )
  })
  if (!onScreen) {
    const workArea = screen.getPrimaryDisplay().workArea
    window.setBounds({
      x: Math.round(workArea.x + (workArea.width - bounds.width) / 2),
      y: Math.round(workArea.y + (workArea.height - bounds.height) / 2),
      width: bounds.width,
      height: bounds.height
    })
  }
}

export function loadRenderer(window: ElectronBrowserWindow): Promise<void> {
  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
  return rendererDevUrl
    ? window.loadURL(rendererDevUrl)
    : window.loadURL('dsh-app://launcher/index.html')
}

/**
 * Resolves the app icon for an unpackaged run.
 *
 * electron-builder embeds the icon into the bundle for packaged builds, so the
 * packaged app already shows the right mark. In `electron-vite dev` the window
 * and Dock otherwise fall back to Electron's own icon, which makes the running
 * preview look like a different product than the one that ships.
 *
 * Resolution is relative to this module, because the dev working directory is
 * not fixed: the same code runs from `out/main` under `npm run dev` and from a
 * test harness with another cwd.
 */
function unpackagedAppIcon(): string | undefined {
  if (app.isPackaged) return undefined
  const candidate = nodePath.resolve(__dirname, '..', '..', 'resources', 'icon-512.png')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Applies the app icon to the macOS Dock for an unpackaged run.
 *
 * A `BrowserWindow` icon does not reach the Dock: without this the dev preview
 * shows Electron's mark in the Dock even though the window itself is correct.
 * Silently skipped where unsupported, so the same call is harmless elsewhere.
 */
function applyDockIcon(): void {
  const icon = unpackagedAppIcon()
  if (icon === undefined || app.dock === undefined) return
  const image = nativeImage.createFromPath(icon)
  if (!image.isEmpty()) app.dock.setIcon(image)
}

/** Creates the sole Launcher application window with no Node renderer authority. */
export function createWindow(
  mainDirectory: string,
  runtimeBrowserController: RuntimeBrowserController
): void {
  applyDockIcon()
  const icon = unpackagedAppIcon()
  const saved = loadWindowBounds()
  const mainWindow = new BrowserWindow({
    ...saved,
    minWidth: 760,
    minHeight: 560,
    title: APP_METADATA.name,
    backgroundColor: '#121820',
    show: false,
    // Omitted when packaged: the bundle's embedded icon takes over there.
    ...(icon === undefined ? {} : { icon }),
    webPreferences: createPreloadWebPreferences(mainDirectory)
  })

  // Keep the saved bounds up to date.
  mainWindow.on('resize', () => saveWindowBounds(mainWindow))
  mainWindow.on('move', () => saveWindowBounds(mainWindow))

  // A display change (monitor unplugged, RDP disconnect) can leave the window
  // on a desktop that no longer exists. Re-centre it on whichever display is
  // still visible when one appears, disappears or resizes.
  screen.on('display-metrics-changed', () => ensureOnScreen(mainWindow))

  installWindowNavigationPolicy(mainWindow.webContents)
  installWebviewPolicy(mainWindow.webContents, runtimeBrowserController)
  void loadRenderer(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    // Check immediately too — the window may have been off-screen at startup.
    ensureOnScreen(mainWindow)
  })
}
