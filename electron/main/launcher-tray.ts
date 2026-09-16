import { app, Menu, nativeImage, Tray } from 'electron'
import nodePath from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'

export type CloseBehavior = 'minimize-to-tray' | 'quit'

interface TrayPreferences {
  closeBehavior: CloseBehavior
}

const PREFS_FILE = 'launcher-tray-preferences.json'
const DEFAULT: CloseBehavior = 'minimize-to-tray'

let tray: Tray | undefined
let mainWindow: BrowserWindow | undefined
let currentBehavior: CloseBehavior = DEFAULT
let closeHandlerInstalled = false

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
  return currentBehavior === 'minimize-to-tray'
}

/** Creates the system tray icon and installs the close-behavour handler. */
export function createTray(window: BrowserWindow): void {
  mainWindow = window
  currentBehavior = read()

  const iconPath = app.isPackaged
    ? nodePath.join(process.resourcesPath, 'icon-512.png')
    : nodePath.join(app.getAppPath(), 'resources', 'icon-512.png')
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : undefined

  tray = new Tray(icon ?? nativeImage.createEmpty())
  tray.setToolTip('DSHKer Launcher')
  tray.on('click', () => app.quit())

  rebuildContextMenu()

  // Single close-handler that reads currentBehavior at event time.
  if (!closeHandlerInstalled) {
    closeHandlerInstalled = true
    window.on('close', (event) => {
      if (currentBehavior === 'minimize-to-tray') {
        event.preventDefault()
        window.hide()
      }
    })
  }
}

/** Destroys the tray icon. Call during shutdown. */
export function destroyTray(): void {
  tray?.destroy()
  tray = undefined
}

function rebuildContextMenu(): void {
  if (!tray) return
  const toggleLabel =
    currentBehavior === 'minimize-to-tray' ? '关闭时直接退出' : '关闭时最小化到托盘'
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 DSHKer Launcher',
        click: () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      {
        label: toggleLabel,
        click: () =>
          setCloseBehavior(currentBehavior === 'minimize-to-tray' ? 'quit' : 'minimize-to-tray')
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
}
