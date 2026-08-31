#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.log(`Validate local runtime versions required by the desktop template.

Usage:
  node tools/environment-check.mjs --json
`)
}

function parseArgs(argv) {
  const args = { json: false }
  for (const arg of argv) {
    if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function parseVersion(value) {
  const match = String(value)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: String(value).trim()
  }
}

function compareVersion(version, target) {
  for (const key of ['major', 'minor', 'patch']) {
    if (version[key] > target[key]) return 1
    if (version[key] < target[key]) return -1
  }
  return 0
}

export function nodeVersionSatisfies(value) {
  const version = parseVersion(value)
  if (!version) return false
  if (version.major === 20) {
    return compareVersion(version, { major: 20, minor: 19, patch: 0 }) >= 0
  }
  return version.major > 22 || (version.major === 22 && version.minor >= 12)
}

export function npmVersionSatisfies(value) {
  const version = parseVersion(value)
  if (!version) return false
  return version.major >= 10
}

async function npmVersion() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', '--version'] : ['--version']
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: appRoot,
      timeout: 10000,
      windowsHide: true
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function packageEngines() {
  const packageJson = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
  return packageJson.engines || {}
}

export async function runEnvironmentCheck() {
  const engines = await packageEngines()
  const node = process.version
  const npm = await npmVersion()
  const checks = [
    {
      name: 'engines.node',
      ok: engines.node === '^20.19.0 || >=22.12.0',
      expected: '^20.19.0 || >=22.12.0',
      actual: engines.node || ''
    },
    {
      name: 'engines.npm',
      ok: engines.npm === '>=10.0.0',
      expected: '>=10.0.0',
      actual: engines.npm || ''
    },
    {
      name: 'runtime.node',
      ok: nodeVersionSatisfies(node),
      expected: '^20.19.0 || >=22.12.0',
      actual: node
    },
    {
      name: 'runtime.npm',
      ok: npmVersionSatisfies(npm),
      expected: '>=10.0.0',
      actual: npm
    }
  ]
  const failures = checks.filter((check) => !check.ok)
  return {
    ok: failures.length === 0,
    checks,
    failures
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }

  const result = await runEnvironmentCheck()
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else if (result.ok) console.log('Environment check passed.')
  else {
    console.error('Environment check failed.')
    for (const failure of result.failures) {
      console.error(`${failure.name}: expected ${failure.expected}, got ${failure.actual}`)
    }
  }

  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`environment-check: ${error.message}`)
    process.exitCode = 1
  })
}
