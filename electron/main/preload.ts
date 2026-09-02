import type { BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'

/** Resolves the CJS preload emitted by electron-vite for the packaged app. */
export function resolvePreloadPath(mainDirectory: string): string {
  return path.join(mainDirectory, '../preload/index.cjs')
}

/** Applies the fixed renderer isolation posture for every launcher window. */
export function createPreloadWebPreferences(
  mainDirectory: string
): BrowserWindowConstructorOptions['webPreferences'] {
  return {
    preload: resolvePreloadPath(mainDirectory),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    // The run page embeds DSH Web in a <webview>, which is a separate top-level
    // browsing context. An <iframe> cannot work here: DSH authenticates with a
    // `SameSite=Strict` session cookie, which a cross-site frame never sends.
    // Every guest is still constrained by the attach policy in security.ts.
    webviewTag: true
  }
}
