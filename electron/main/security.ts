import { BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'

function devRendererOrigin(): string | undefined {
  const url = process.env.ELECTRON_RENDERER_URL
  return url ? new URL(url).origin : undefined
}

function isAllowedRendererUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  const devOrigin = devRendererOrigin()
  if (devOrigin) return url.origin === devOrigin
  return url.protocol === 'dsh-app:' && url.hostname === 'launcher'
}

/** Confirms that an IPC request comes from the current top-level launcher page. */
export function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  const sender = event.sender
  const owner = BrowserWindow.fromWebContents(sender)
  return (
    Boolean(owner) &&
    !sender.isDestroyed() &&
    event.senderFrame === sender.mainFrame &&
    isAllowedRendererUrl(event.senderFrame.url)
  )
}

/** Admits only a loopback http(s) origin, the addresses `dsh web` can announce. */
function isLoopbackRuntimeUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/**
 * Constrains every <webview> the run page attaches.
 *
 * The guest exists only to host the DSH Web runtime, so it may load nothing but
 * a loopback address, gets no preload and no Node integration, and cannot open
 * windows or navigate away from loopback.
 */
export function installWebviewPolicy(contents: WebContents): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (typeof params.src !== 'string' || !isLoopbackRuntimeUrl(params.src)) {
      event.preventDefault()
    }
  })
  contents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-navigate', (event, targetUrl) => {
      if (!isLoopbackRuntimeUrl(targetUrl)) event.preventDefault()
    })
  })
}

/** Denies untrusted navigation and every renderer-created window. */
export function installWindowNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl)) event.preventDefault()
  })
}
