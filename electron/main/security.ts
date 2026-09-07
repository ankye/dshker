import { app, BrowserWindow, Menu, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { LOCAL_PARTITION, isPeerPartition } from './p2p/partitions'
import { runtimeContextMenuTemplate, type RuntimeContextMenuLocale } from './runtime-context-menu'
import { type RuntimeBrowserController } from './runtime-browser-controller'

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

/** Matches the native menu language to the operating-system locale when available. */
function runtimeContextMenuLocale(): RuntimeContextMenuLocale {
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Admits only session partitions this application allocates.
 *
 * Without this check a run page could attach a guest to an arbitrary partition
 * and inherit another computer's cookies and tokens. `Local` keeps its own
 * partition, and every remote workbench uses a label derived from its pinned
 * pair identity, so an unrecognised or hand-written value is refused.
 */
function isAllowedGuestPartition(value: unknown): boolean {
  if (value === undefined || value === LOCAL_PARTITION) return true
  return isPeerPartition(value)
}

/**
 * Constrains every <webview> the run page attaches.
 *
 * The guest exists only to host the DSH Web runtime, so it may load nothing but
 * a loopback address, gets no preload and no Node integration, cannot open
 * windows or navigate away from loopback, and must sit in an allocated session
 * partition so remote workbenches stay isolated from each other and from Local.
 */
export function installWebviewPolicy(
  contents: WebContents,
  runtimeBrowserController: RuntimeBrowserController
): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    if (typeof params.src !== 'string' || !isLoopbackRuntimeUrl(params.src)) {
      event.preventDefault()
      return
    }
    if (!isAllowedGuestPartition((params as { partition?: unknown }).partition)) {
      event.preventDefault()
    }
  })
  contents.on('did-attach-webview', (_event, guest) => {
    runtimeBrowserController.attach(contents, guest)
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('will-navigate', (event, targetUrl) => {
      if (!isLoopbackRuntimeUrl(targetUrl)) event.preventDefault()
    })
    guest.on('context-menu', (event, params) => {
      event.preventDefault()
      Menu.buildFromTemplate(runtimeContextMenuTemplate(guest, runtimeContextMenuLocale())).popup({
        window: BrowserWindow.fromWebContents(contents) ?? undefined,
        x: params.x,
        y: params.y
      })
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
