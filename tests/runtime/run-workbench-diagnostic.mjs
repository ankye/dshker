import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../..', import.meta.url))
const [harness, temporary] = process.argv.slice(2)
if (!harness || !temporary || !isAbsolute(harness) || !isAbsolute(temporary))
  throw new Error('Explicit Harness and isolated diagnostic paths are required')
const project = resolve(temporary, 'project')
const userData = resolve(temporary, 'electron')
await mkdir(project, { recursive: true })
await mkdir(userData, { recursive: true })
const entry = resolve(temporary, 'native-driver.mjs')
await build({
  entryPoints: [resolve(root, 'tests/runtime/workbench-native-driver.ts')],
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  target: 'node22'
})
const dsh = spawn(
  process.execPath,
  [resolve(harness, 'apps/cli/lib/bin.js'), '--profile', 'web', '--no-open', '--port', '0'],
  {
    cwd: project,
    env: { ...process.env, DSH_HOME: resolve(temporary, 'home') },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)
const dshExit = once(dsh, 'exit')
let log = ''
const redact = (text) => text.replace(/token=[^\s&"']+/g, 'token=[REDACTED]')
const announced = new Promise((resolveURL, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`DSH startup timeout: ${redact(log.slice(-3000))}`)),
    70_000
  )
  const receive = (chunk) => {
    log = (log + chunk.toString()).slice(-64 * 1024)
    const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(log)
    if (match) {
      clearTimeout(timer)
      resolveURL(match[1])
    }
  }
  dsh.stdout.on('data', receive)
  dsh.stderr.on('data', receive)
  dsh.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
  dsh.once('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`DSH exited ${code}: ${redact(log.slice(-3000))}`))
  })
})
let electron
try {
  const url = await announced
  const executable = createRequire(import.meta.url)('electron')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  electron = spawn(executable, [entry], {
    cwd: root,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const exited = once(electron, 'exit')
  const timer = setTimeout(() => electron.kill('SIGTERM'), 45_000)
  electron.stdout.on('data', (chunk) => process.stdout.write(redact(chunk.toString())))
  electron.stderr.on('data', (chunk) => process.stderr.write(redact(chunk.toString())))
  electron.stdin.end(
    JSON.stringify({
      url,
      project,
      userData,
      preload: resolve(root, 'out/preload/workbench.cjs'),
      screenshot: resolve(temporary, 'workbench.png')
    })
  )
  const [code] = await exited
  clearTimeout(timer)
  if (code !== 0)
    throw new Error(
      `Native workbench diagnostic exited ${code}; DSH output: ${redact(log.slice(-3000))}`
    )
} finally {
  if (electron && electron.exitCode === null) electron.kill('SIGTERM')
  if (dsh.exitCode === null) {
    dsh.kill('SIGTERM')
    const force = setTimeout(() => dsh.kill('SIGKILL'), 5000)
    await dshExit
    clearTimeout(force)
  }
}
