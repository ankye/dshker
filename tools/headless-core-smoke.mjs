#!/usr/bin/env node
// Release gate for the headless entry point.
//
// The packaged core binary is one artifact with two lives: the shell starts it as
// a child, and an operator runs it with no desktop session at all. This gate
// proves the second life on the machine running it — the binary resolves and
// matches its manifest, `serve` publishes its own endpoint and reports serving,
// a named command answers over that endpoint, and a refusal keeps its typed code
// on the terminal.
//
// It writes .run/headless-core/latest.json either way, so a failing gate always
// leaves the observation that explains it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const appRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetPattern = /^(darwin|win32|linux)-(arm64|x64)$/

function usage() {
  console.log(`Check that this machine's core binary answers as a headless host.

Usage:
  node tools/headless-core-smoke.mjs [--json] [--app-root DIR] [--target T] [--timeout-ms N]

Options:
  --json            Emit the evidence document instead of a summary.
  --app-root DIR    Repository root to read build/p2p and write .run/ under.
  --target TARGET   platform-arch to verify. Default: this machine.
  --timeout-ms N    Per-command timeout. Default: 30000.
  --build           Build the core for the target first instead of requiring it.
  --help            Show this help.
`)
}

function parseArgs(argv) {
  const args = {
    json: false,
    appRoot: appRootDefault,
    target: `${process.platform}-${process.arch}`,
    timeoutMs: 30_000,
    build: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--build') args.build = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--app-root' || arg === '--target' || arg === '--timeout-ms') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--app-root') args.appRoot = path.resolve(value)
      else if (arg === '--target') {
        if (!targetPattern.test(value)) throw new Error(`Unsupported target: ${value}`)
        args.target = value
      } else {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Invalid --timeout-ms value')
        args.timeoutMs = parsed
      }
      index += 1
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

/**
 * Resolves the core for one target and proves the bytes match their manifest.
 *
 * The target is explicit because a cross-built installer is verified on the host
 * that built it: a win32-arm64 core cannot run on an x64 machine, and the gate
 * must still name the file it checked rather than checking another one.
 */
async function resolveCore(appRoot, target) {
  if (!targetPattern.test(target)) {
    return { ok: false, target, detail: `Unsupported target: ${target}.` }
  }
  const [platform, arch] = target.split('-')
  const file = platform === 'win32' ? 'dshkerd.exe' : 'dshkerd'
  const directory = path.join(appRoot, 'build', 'p2p', target)
  const executable = path.join(directory, file)
  const buildHint = `Run: node tools/build-peer-helper.mjs --platform ${platform} --arch ${arch}`
  let info
  try {
    info = await lstat(executable)
  } catch {
    return {
      ok: false,
      target,
      detail: `No core for this machine at build/p2p/${target}/${file}. ${buildHint}`
    }
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    return {
      ok: false,
      target,
      detail: `build/p2p/${target}/${file} is not a regular file. ${buildHint}`
    }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'dshkerd-manifest.json'), 'utf8'))
  } catch {
    return {
      ok: false,
      target,
      executable,
      detail: `dshkerd-manifest.json is missing or unreadable in build/p2p/${target}. ${buildHint}`
    }
  }
  const sha256 = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  if (manifest.version !== 1 || manifest.target !== target || manifest.file !== file) {
    return {
      ok: false,
      target,
      executable,
      detail: `manifest describes ${manifest.target ?? 'an unknown target'}, but this machine needs ${target}.`
    }
  }
  if (manifest.sha256 !== sha256) {
    return {
      ok: false,
      target,
      executable,
      sha256,
      detail: 'the core does not match its manifest, so the app would refuse it'
    }
  }
  return { ok: true, target, executable, sha256 }
}

/** Runs one core command to completion and returns what the terminal saw. */
function runCore(executable, arguments_, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, stdout: stdout.join(''), stderr: stderr.join(''), timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        code: null,
        stdout: stdout.join(''),
        stderr: String(error.message),
        timedOut: false
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.join(''), stderr: stderr.join(''), timedOut: false })
    })
  })
}

/** Starts `serve` and waits for the readiness line it prints once it listens. */
async function startServing(executable, state, timeoutMs) {
  const child = spawn(executable, ['serve', '--state', state], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let buffered = ''
  const readiness = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk)
      const line = buffered.split(/\r?\n/).find((candidate) => candidate.trim().startsWith('{'))
      if (line === undefined) return
      try {
        const parsed = JSON.parse(line)
        if (parsed.serving === true && typeof parsed.socket === 'string') {
          clearTimeout(timer)
          resolve(parsed)
        }
      } catch {
        // A partial line is not an answer; the next chunk completes it.
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
  return { child, readiness }
}

async function stopServing(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  await stopped
  clearTimeout(timer)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  const startedAt = new Date()
  const started = performance.now()
  const observations = []
  const failures = []
  let core = { ok: false, detail: 'the core was never resolved' }
  let state = ''
  let child = undefined
  try {
    if (args.build) {
      // The gate builds for the target it verifies and never copies an artifact
      // from elsewhere: a core built for another target is refused by the app.
      const built = await runCore(
        process.execPath,
        [
          path.join(args.appRoot, 'tools', 'build-peer-helper.mjs'),
          '--platform',
          args.target.split('-')[0],
          '--arch',
          args.target.split('-')[1]
        ],
        Math.max(args.timeoutMs, 300_000)
      )
      const builtOk = built.code === 0
      observations.push({
        name: 'core-build',
        ok: builtOk,
        detail: builtOk
          ? `built the ${args.target} core`
          : `build exited ${built.code}: ${(built.stderr || built.stdout).trim().split('\n').slice(-2).join(' ')}`
      })
      if (!builtOk) failures.push('core-build')
    }
    core = await resolveCore(args.appRoot, args.target)
    observations.push({
      name: 'core-binary',
      ok: core.ok,
      detail: core.detail ?? `verified ${core.target}`
    })
    if (!core.ok) failures.push('core-binary')
    if (core.ok && failures.length === 0) {
      state = await mkdtemp(path.join(os.tmpdir(), 'dshkerd-headless-'))
      const serving = await startServing(core.executable, state, args.timeoutMs)
      child = serving.child
      observations.push({
        name: 'serve-publishes-its-own-endpoint',
        ok: serving.readiness !== undefined,
        detail:
          serving.readiness === undefined
            ? 'serve did not report serving within the timeout'
            : `serving on ${serving.readiness.socket}`
      })
      if (serving.readiness === undefined) failures.push('serve-publishes-its-own-endpoint')

      const status = await runCore(
        core.executable,
        ['status', '--state', state, '--json'],
        args.timeoutMs
      )
      const statusOk = status.code === 0 && status.stdout.includes('"version"')
      observations.push({
        name: 'named-command-over-the-private-endpoint',
        ok: statusOk,
        detail: statusOk
          ? 'status answered the core table and the runtime'
          : `status exited ${status.code}: ${(status.stderr || status.stdout).trim()}`
      })
      if (!statusOk) failures.push('named-command-over-the-private-endpoint')

      const proxy = await runCore(core.executable, ['proxy', '--state', state], args.timeoutMs)
      const refusal = proxy.stderr.trim()
      const proxyOk = proxy.code === 1 && refusal === 'p2p.runtime_unavailable'
      observations.push({
        name: 'refusal-keeps-its-code',
        ok: proxyOk,
        detail: proxyOk
          ? 'proxy refused with p2p.runtime_unavailable, as a host with no child must'
          : `proxy exited ${proxy.code}: ${refusal || proxy.stdout.trim()}`
      })
      if (!proxyOk) failures.push('refusal-keeps-its-code')
    }
  } catch (error) {
    failures.push('smoke')
    observations.push({ name: 'smoke', ok: false, detail: String(error?.message ?? error) })
  } finally {
    if (child !== undefined) await stopServing(child)
    if (state !== '') await rm(state, { force: true, recursive: true })
  }

  const evidence = {
    schemaVersion: 1,
    ok: failures.length === 0,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    platform: process.platform,
    arch: process.arch,
    target: args.target,
    executable: core.executable === undefined ? '' : path.relative(args.appRoot, core.executable),
    sha256: core.sha256 ?? '',
    observations,
    failures
  }
  const outputDir = path.join(args.appRoot, '.run', 'headless-core')
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(evidence, null, 2)}\n`)

  if (args.json) console.log(JSON.stringify(evidence, null, 2))
  else {
    for (const observation of observations) {
      console.log(
        `${observation.ok ? 'PASS' : 'FAIL'}  ${observation.name}\n      ${observation.detail}\n`
      )
    }
    if (!evidence.ok) console.log('The headless entry point is not ready. See above.\n')
  }
  if (!evidence.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`headless-core-smoke: ${error.message}`)
    process.exitCode = 1
  })
}
