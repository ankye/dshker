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

/** Denies untrusted navigation and every renderer-created window. */
export function installWindowNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl)) event.preventDefault()
  })
}
