import { BrowserWindow, app, nativeImage } from 'electron'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import nodePath from 'node:path'
import { APP_METADATA } from '../../src/shared/contracts'
import { createPreloadWebPreferences } from './preload'
import { installWebviewPolicy, installWindowNavigationPolicy } from './security'
import { type RuntimeBrowserController } from './runtime-browser-controller'

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
  const candidate = nodePath.resolve(
    __dirname,
    '..',
    '..',
    'resources',
    'dsh-launcher-logo-launcher.png'
  )
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
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: APP_METADATA.name,
    backgroundColor: '#121820',
    show: false,
    // Omitted when packaged: the bundle's embedded icon takes over there.
    ...(icon === undefined ? {} : { icon }),
    webPreferences: createPreloadWebPreferences(mainDirectory)
  })

  installWindowNavigationPolicy(mainWindow.webContents)
  installWebviewPolicy(mainWindow.webContents, runtimeBrowserController)
  void loadRenderer(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}
