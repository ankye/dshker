import { app, BrowserWindow, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WorkbenchGuests } from '../../electron/main/workbench-guests'
import { WORKBENCH_CHANNELS } from '../../packages/dshker-workbench-client/src/protocol'

// Diagnostic only: runs the actual DSH page, plugin and production guest controller.
async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(0, 'utf8')) as {
    url: string
    project: string
    userData: string
    preload: string
    screenshot: string
  }
  app.setPath('userData', config.userData)
  const endpoint = new URL(config.url)
  if (endpoint.hostname !== '127.0.0.1' || !endpoint.searchParams.has('token'))
    throw new Error('Missing announced local runtime identity')
  const authenticated = await fetch(endpoint, { redirect: 'manual' })
  const cookie = authenticated.headers.get('set-cookie')?.split(';')[0]
  if (authenticated.status !== 303 || !cookie)
    throw new Error(`DSH authentication exchange failed: ${authenticated.status}`)

  async function rpc(method: string, request: unknown): Promise<Record<string, unknown>> {
    const id = randomUUID()
    const response = await fetch(`${endpoint.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie!, origin: endpoint.origin },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: id,
        method,
        payload: { args: { request } }
      })
    })
    if (!response.ok) throw new Error(`DSH API status ${response.status}`)
    const body = (await response.json()) as {
      rpcId: string
      result: { ok: boolean; value: Record<string, unknown>; error?: { code: string } }
    }
    if (body.rpcId !== id || !body.result.ok)
      throw new Error(`DSH API rejected ${method}: ${body.result.error?.code}`)
    return body.result.value
  }

  const workspaceValue = await rpc('workspace/create', { path: config.project })
  const workspace = workspaceValue.workspace as { workspaceId: string; path: string }
  if (workspace.path !== config.project) throw new Error('Workspace path readback mismatch')
  const sessionId = `session-${randomUUID()}`
  const session = await rpc('session/create', { workspaceId: workspace.workspaceId, sessionId })
  if (session.sessionId !== sessionId) throw new Error('Session identity readback mismatch')
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: config.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  const guests = new WorkbenchGuests(ipcMain)
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.message.includes('workbench'))
      process.stderr.write(`DSH client: ${event.message.slice(0, 1200)}\n`)
  })
  window.webContents.on('preload-error', (_event, _path, error) =>
    process.stderr.write(`Guest preload failed: ${error.message}\n`)
  )
  const scope = {
    computerId: 'diagnostic-remote',
    attemptId: randomUUID(),
    runtimeGeneration: 1,
    origin: endpoint.origin
  }
  guests.register(window.webContents, scope)
  const waitReady = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener(WORKBENCH_CHANNELS.ready, listener)
        reject(new Error('Actual DSH client did not register the workbench extension'))
      }, 20_000)
      const listener: Parameters<typeof ipcMain.on>[1] = (event, payload) => {
        if (event.sender !== window.webContents || payload?.available !== true) return
        clearTimeout(timer)
        ipcMain.removeListener(WORKBENCH_CHANNELS.ready, listener)
        resolve()
      }
      ipcMain.on(WORKBENCH_CHANNELS.ready, listener)
    })
  try {
    const ready = waitReady()
    await window.loadURL(config.url)
    await ready
    const target = { workspaceId: workspace.workspaceId, sessionId, path: workspace.path }
    const result = await guests.request(
      window.webContents.id,
      scope,
      'navigate',
      target,
      new AbortController().signal
    )
    if (JSON.stringify(result) !== JSON.stringify(target))
      throw new Error('Client navigation readback mismatch')
    const again = await guests.request(
      window.webContents.id,
      scope,
      'selection',
      target,
      new AbortController().signal
    )
    if (JSON.stringify(again) !== JSON.stringify(target))
      throw new Error('Client selection changed during readback')
    // Exercise an already loaded client receiving a newly created session:
    // this requires the actual workspace feed to catch up with session refresh.
    const secondId = `session-${randomUUID()}`
    const second = await rpc('session/create', {
      workspaceId: workspace.workspaceId,
      sessionId: secondId
    })
    if (second.sessionId !== secondId) throw new Error('Second session identity mismatch')
    const secondTarget = { ...target, sessionId: secondId }
    const switched = await guests.request(
      window.webContents.id,
      scope,
      'navigate',
      secondTarget,
      new AbortController().signal
    )
    if (JSON.stringify(switched) !== JSON.stringify(secondTarget))
      throw new Error('Live session switch mismatch')
    // A new document must register again; an old document's readiness is invalid.
    const reloaded = waitReady()
    await window.loadURL(endpoint.origin)
    await reloaded
    const restored = await guests.request(
      window.webContents.id,
      scope,
      'navigate',
      target,
      new AbortController().signal
    )
    if (JSON.stringify(restored) !== JSON.stringify(target))
      throw new Error('Reloaded session navigation mismatch')
    // Reject a real session paired with a foreign path without changing selection.
    try {
      await guests.request(
        window.webContents.id,
        scope,
        'navigate',
        { ...target, path: `${target.path}/not-the-workspace` },
        new AbortController().signal
      )
      throw new Error('Mismatched workspace path was accepted')
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'workbench.workspace_mismatch') throw error
    }
    const unchanged = await guests.request(
      window.webContents.id,
      scope,
      'selection',
      target,
      new AbortController().signal
    )
    if (JSON.stringify(unchanged) !== JSON.stringify(target))
      throw new Error('Rejected navigation changed selection')
    const capture = await window.webContents.capturePage()
    await writeFile(config.screenshot, capture.toPNG())
    process.stdout.write(
      JSON.stringify({
        status: 'verified',
        stage: 'diagnostic',
        checks: [
          'actual-plugin-load',
          'navigate-readback',
          'live-session-switch',
          'reload-reregister',
          'reject-wrong-path-without-switch'
        ],
        workspaceId: workspace.workspaceId,
        sessionId,
        path: workspace.path,
        screenshot: config.screenshot
      }) + '\n'
    )
  } finally {
    guests.dispose()
    window.destroy()
    app.quit()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Workbench diagnostic failed'}\n`
  )
  app.exit(1)
})
