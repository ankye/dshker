import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronViteBin = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)
const port =
  process.env.ELECTRON_RENDERER_SMOKE_PORT || String(9333 + Math.floor(Math.random() * 700))

function parseArgs(argv) {
  const args = { json: false }
  for (const arg of argv) {
    if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function usage() {
  console.log(`Run a real Electron renderer smoke.

Usage:
  node tools/electron-renderer-smoke.mjs --json
`)
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`)
  return response.json()
}

async function waitForTarget() {
  const deadline = Date.now() + 30000
  let lastError
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await delay(500)
  }
  throw new Error(`Electron renderer debugger target not available: ${lastError?.message || port}`)
}

function createCdpClient(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP websocket failed')), {
      once: true
    })
  })

  return {
    async send(method, params = {}) {
      await opened
      const id = nextId++
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() {
      socket.close()
    }
  }
}

async function waitForRendererReady(client) {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  const expression = `
    (async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 120; i++) {
        if (document.body && document.body.children.length > 0) {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { ok: true, title: document.title, bodyChildren: document.body.children.length };
        }
        await wait(250);
      }
      return { ok: false, error: 'Renderer body did not mount.' };
    })()
  `
  let result
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      result = await client.send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true
      })
      break
    } catch (error) {
      if (!String(error.message || error).includes('Execution context was destroyed')) throw error
      await delay(500)
    }
  }
  if (!result) throw new Error('Renderer context was not stable for smoke.')
  const value = result.result?.value
  if (!value?.ok) throw new Error(value?.error || 'Electron renderer smoke failed')
  const screenshotDir = path.join(appRoot, '.run', 'electron-smoke')
  await mkdir(screenshotDir, { recursive: true })
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = path.join(screenshotDir, 'renderer.png')
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  return {
    ...value,
    screenshot: path.relative(appRoot, screenshotPath).replaceAll(path.sep, '/')
  }
}

export async function runElectronRendererSmoke() {
  const userDataRoot = await mkdtemp(path.join(os.tmpdir(), 'desktop-renderer-smoke-'))
  const child = spawn(process.execPath, [electronViteBin, 'dev'], {
    env: {
      ...process.env,
      ELECTRON_REMOTE_DEBUGGING_PORT: port,
      DESKTOP_APP_USER_DATA_ROOT: userDataRoot,
      GAM_USER_DATA_ROOT: userDataRoot
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  let client
  try {
    const target = await waitForTarget()
    client = createCdpClient(target.webSocketDebuggerUrl)
    const result = await waitForRendererReady(client)
    return { ok: true, port, result }
  } catch (error) {
    return { ok: false, port, error: error.message, logs: logs.join('').slice(-4000) }
  } finally {
    client?.close()
    child.kill()
    await delay(500)
    if (!child.killed) child.kill('SIGKILL')
    await rm(userDataRoot, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const result = await runElectronRendererSmoke()
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) console.log('Electron renderer smoke passed.')
  else console.error(`Electron renderer smoke failed: ${result.error}`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`electron-renderer-smoke: ${error.message}`)
    process.exitCode = 1
  })
}
