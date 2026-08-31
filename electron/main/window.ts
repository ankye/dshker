import { BrowserWindow } from 'electron'
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { APP_METADATA } from '../../src/shared/contracts'
import { createPreloadWebPreferences } from './preload'
import { installWindowNavigationPolicy } from './security'

export function loadRenderer(window: ElectronBrowserWindow): Promise<void> {
  const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
  return rendererDevUrl
    ? window.loadURL(rendererDevUrl)
    : window.loadURL('dsh-app://launcher/index.html')
}

/** Creates the sole Launcher application window with no Node renderer authority. */
export function createWindow(mainDirectory: string): void {
  const mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: APP_METADATA.name,
    backgroundColor: '#121820',
    show: false,
    webPreferences: createPreloadWebPreferences(mainDirectory)
  })

  installWindowNavigationPolicy(mainWindow.webContents)
  void loadRenderer(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
}
