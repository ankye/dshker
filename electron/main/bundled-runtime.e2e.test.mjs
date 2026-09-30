import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runtimeRoot = path.join(appRoot, 'resources', 'runtime')
assert.ok(
  existsSync(path.join(runtimeRoot, 'versions.json')),
  'no staged runtime at resources/runtime: run npm run runtime:prepare first'
)

const directory = mkdtempSync(path.join(tmpdir(), 'pnpm-bundled-live-'))
try {
  const output = path.join(directory, 'resolver.cjs')
  await build({
    entryPoints: ['electron/main/pnpm-launcher.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output
  })
  const launcher = createRequire(import.meta.url)(output).resolvePnpmLauncher(runtimeRoot)
  assert.equal(launcher.resolutionError, undefined)
  // The bundled launcher runs the pinned pnpm entry on the Launcher's own
  // process with --expose-internals, and hands it a bin-first command PATH.
  assert.equal(launcher.executable, process.execPath)
  assert.deepEqual(launcher.prefixArguments, [
    '--expose-internals',
    path.join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs')
  ])
  assert.equal(launcher.commandSearchPath.split(path.delimiter)[0], path.join(runtimeRoot, 'bin'))

  const result = spawnSync(launcher.executable, [...launcher.prefixArguments, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: {
      ...process.env,
      PATH: launcher.commandSearchPath,
      DSHKER_NODE_EXECUTABLE: launcher.executable
    }
  })
  assert.equal(result.status, 0, result.stderr)
  const descriptor = JSON.parse(readFileSync(path.join(runtimeRoot, 'versions.json'), 'utf8'))
  assert.equal(descriptor.schemaVersion, 1)
  assert.equal(result.stdout.trim(), descriptor.pnpm)
  mkdirSync('.run/pnpm-startup-repair', { recursive: true })
  writeFileSync(
    '.run/pnpm-startup-repair/bundled.json',
    JSON.stringify({
      status: result.status,
      version: result.stdout.trim(),
      executable: launcher.executable,
      schemaVersion: descriptor.schemaVersion,
      pnpm: descriptor.pnpm
    })
  )
  console.log('Real bundled pnpm probe passed:', result.stdout.trim())
} finally {
  rmSync(directory, { recursive: true, force: true })
}
