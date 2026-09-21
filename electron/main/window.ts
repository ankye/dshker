import { BrowserWindow, app, nativeImage, screen } from 'electron'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import nodePath from 'node:path'
import { APP_METADATA } from '../../src/shared/contracts'
import { createPreloadWebPreferences } from './preload'
import { installWebviewPolicy, installWindowNavigationPolicy } from './security'
import { type RuntimeBrowserController } from './runtime-browser-controller'
import { placeInLayout } from './window-placement'

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
 * Reads the saved window bounds from `userData`, corrected for the display layout
 * that exists right now.
 *
 * A remembered position is clamped onto a real display rather than discarded. The
 * previous version returned `{}` whenever the saved spot was unreachable, which left
 * `x`/`y` undefined and handed placement to the platform — so a window remembered on
 * a monitor that is now unplugged reopened wherever the OS felt like, and the user's
 * size was kept while their position was silently thrown away. Clamping preserves as
 * much of the remembered placement as the current monitors allow.
 */
function loadWindowBounds(): Partial<Electron.Rectangle> {
  try {
    const file = nodePath.join(app.getPath('userData'), 'launcher-window-state.json')
    const raw = readFileSync(file, 'utf8')
    const saved = JSON.parse(raw) as SavedWindowBounds
    if (
      !Number.isFinite(saved.x) ||
      !Number.isFinite(saved.y) ||
      !Number.isFinite(saved.width) ||
      !Number.isFinite(saved.height) ||
      saved.width <= 0 ||
      saved.height <= 0
    )
      return {}
    return placeInLayout(
      { x: saved.x, y: saved.y, width: saved.width, height: saved.height },
      screen.getAllDisplays().map((display) => display.workArea)
    )
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
    writeFileSync(
      file,
      JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
      'utf8'
    )
  } catch {
    // Best-effort: a failed write must not interfere with the window itself.
  }
}

/**
 * Brings a window back onto a reachable display when the display layout changed.
 *
 * The displays are read fresh on every call, never cached: on Windows the removal
 * event can arrive before the display list settles, so the answer must come from
 * whatever `screen` reports at the moment of the fix.
 *
 * A minimised or full-screen window is left alone. Moving a minimised window would
 * write a position the user never chose into the saved state, and a full-screen
 * window is owned by the platform's own display handling.
 */
function ensureOnScreen(window: ElectronBrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return
  const bounds = window.getBounds()
  const placed = placeInLayout(
    bounds,
    screen.getAllDisplays().map((display) => display.workArea)
  )
  if (
    placed.x !== bounds.x ||
    placed.y !== bounds.y ||
    placed.width !== bounds.width ||
    placed.height !== bounds.height
  )
    window.setBounds(placed)
}

export function loadRenderer(window: ElectronBrowserWindow): Promise<void> {
  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
  return rendererDevUrl
    ? window.loadURL(rendererDevUrl)
    : window.loadURL('dsh-app://launcher/index.html')
}

/** Reveals an existing hidden/minimised window when the app is activated again. */
export function revealWindow(window: ElectronBrowserWindow): boolean {
  if (window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
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
    x: saved.x,
    y: saved.y,
    width: saved.width ?? DEFAULT_WIDTH,
    height: saved.height ?? DEFAULT_HEIGHT,
    minWidth: 760,
    minHeight: 560,
    title: APP_METADATA.name,
    backgroundColor: '#121820',
    show: false,
    // Omitted when packaged: the bundle's embedded icon takes over there.
    ...(icon === undefined ? {} : { icon }),
    webPreferences: createPreloadWebPreferences(mainDirectory)
  })

  // Keep the saved bounds up to date, but only once the window is really up.
  //
  // Creation and first paint emit their own move/resize events. Persisting those
  // wrote the platform's startup placement over the position the user chose, so a
  // window recovered from an unplugged monitor lost its remembered spot for good.
  let placementSettled = false
  mainWindow.on('resize', () => {
    if (placementSettled) saveWindowBounds(mainWindow)
  })
  mainWindow.on('move', () => {
    if (placementSettled) saveWindowBounds(mainWindow)
  })

  // A display change can leave the window on a desktop that no longer exists.
  //
  // All three events matter and they are distinct: unplugging a monitor emits
  // `display-removed`, attaching one emits `display-added`, and only a resolution or
  // scale change emits `display-metrics-changed`. Subscribing to the last alone —
  // which is what this did — meant the common case, pulling out a monitor, was never
  // handled at all and the window stayed on coordinates that no longer existed.
  const recover = (): void => ensureOnScreen(mainWindow)
  screen.on('display-removed', recover)
  screen.on('display-added', recover)
  screen.on('display-metrics-changed', recover)
  // The listeners outlive nothing: dropping them with the window keeps a closed
  // window from being resized by a later display change.
  mainWindow.on('closed', () => {
    screen.off('display-removed', recover)
    screen.off('display-added', recover)
    screen.off('display-metrics-changed', recover)
  })

  installWindowNavigationPolicy(mainWindow.webContents)
  installWebviewPolicy(mainWindow.webContents, runtimeBrowserController)
  void loadRenderer(mainWindow)

  mainWindow.once('ready-to-show', () => {
    // Correct the placement before showing, so the window never appears on a
    // desktop that is gone and then jumps.
    ensureOnScreen(mainWindow)
    mainWindow.show()
    // From here on the window's geometry is the user's, so it is worth saving.
    placementSettled = true
  })
}
