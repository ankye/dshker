#!/usr/bin/env node
/**
 * Captures every launcher route in both themes and both locales for design
 * review, then reports measured overflow and contrast-relevant facts.
 *
 * This exists because the packaged renderer smoke captures a single route in a
 * single theme, which cannot demonstrate that a multi-theme, multi-locale
 * interface is actually correct on each surface.
 *
 * Usage: node tools/theme-locale-capture.mjs [--url <devServerUrl>] [--out <dir>]
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import os from 'node:os'

const CHROMIUM_ROOT = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64'
)
const ROUTES = ['launch', 'advanced', 'versions', 'controller', 'usage', 'settings', 'runtime']
const THEMES = ['dark', 'light']
const LOCALES = ['zh-CN', 'en-US']
const VIEWPORT = { width: 1240, height: 820 }

function parseArgs(argv) {
  const args = { url: 'http://127.0.0.1:5173/', out: '.run/theme-capture' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') args.url = argv[index + 1]
    if (argv[index] === '--out') args.out = argv[index + 1]
  }
  return args
}

async function resolveChromiumBinary() {
  const entries = await readdir(CHROMIUM_ROOT)
  const app = entries.find((entry) => entry.endsWith('.app'))
  if (!app) throw new Error(`No Chromium app bundle under ${CHROMIUM_ROOT}`)
  return path.join(CHROMIUM_ROOT, app, 'Contents/MacOS', app.replace(/\.app$/u, ''))
}

function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`Port ${port} never opened`))
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

/** Minimal CDP client over the browser WebSocket endpoint. */
async function connect(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  const { webSocketDebuggerUrl } = await response.json()
  const { WebSocket } = await import('node:worker_threads').then(() => globalThis)
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })

  return { send, close: () => socket.close() }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = path.resolve(args.out)
  await mkdir(outDir, { recursive: true })

  const port = 9412
  const binary = await resolveChromiumBinary()
  const profile = path.join(os.tmpdir(), `dsh-capture-${Date.now()}`)
  const chromium = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  const findings = []
  try {
    await waitForPort(port)
    const browser = await connect(port)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const call = (method, params) => browser.send(method, params, sessionId)

    await call('Page.enable')
    await call('Runtime.enable')
    await call('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: 2,
      mobile: false
    })

    await call('Page.navigate', { url: args.url })
    await new Promise((resolve) => setTimeout(resolve, 2500))

    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        // Drive the app's own persisted state, then reload so startup paths run.
        await call('Runtime.evaluate', {
          expression: `(() => {
            localStorage.setItem('dsh-launcher.theme', ${JSON.stringify(theme)})
            localStorage.setItem('dsh-launcher.locale', ${JSON.stringify(locale)})
            return true
          })()`
        })
        await call('Page.reload')
        await new Promise((resolve) => setTimeout(resolve, 1800))

        for (const route of ROUTES) {
          const clicked = await call('Runtime.evaluate', {
            expression: `(() => {
              const target = document.querySelector('[data-testid="nav-${route}"]')
              if (!target) return 'missing'
              target.click()
              return 'ok'
            })()`,
            awaitPromise: true
          })
          if (clicked.result.value !== 'ok') {
            findings.push({ route, theme, locale, error: 'nav item not found' })
            continue
          }
          await new Promise((resolve) => setTimeout(resolve, 650))

          const audit = await call('Runtime.evaluate', {
            expression: `(() => {
              const documentElement = document.documentElement
              const horizontal = documentElement.scrollWidth > documentElement.clientWidth + 1
              const overflowing = [...document.querySelectorAll('*')]
                .filter((node) => {
                  const rect = node.getBoundingClientRect()
                  return rect.width > 0 && rect.right > window.innerWidth + 1
                })
                .slice(0, 6)
                .map((node) => node.className && typeof node.className === 'string'
                  ? node.className.split(' ')[0]
                  : node.tagName.toLowerCase())
              const empty = document.querySelector('.empty-state')
              return JSON.stringify({
                theme: documentElement.dataset.theme,
                lang: documentElement.lang,
                horizontal,
                overflowing,
                emptyState: empty
                  ? {
                      tone: empty.getAttribute('data-tone'),
                      title: empty.querySelector('.empty-state-title')?.textContent?.trim(),
                      actions: [...empty.querySelectorAll('.empty-state-actions button')]
                        .map((button) => button.textContent.trim())
                    }
                  : null
              })
            })()`,
            returnByValue: true
          })

          findings.push({ route, theme, locale, ...JSON.parse(audit.result.value) })

          const shot = await call('Page.captureScreenshot', { format: 'png' })
          await writeFile(
            path.join(outDir, `${locale}-${theme}-${route}.png`),
            Buffer.from(shot.data, 'base64')
          )
        }
      }
    }

    browser.close()
  } finally {
    chromium.kill('SIGTERM')
  }

  const report = {
    ok: findings.every((entry) => !entry.error && !entry.horizontal),
    outputDir: path.relative(process.cwd(), outDir),
    findings
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

await main()
