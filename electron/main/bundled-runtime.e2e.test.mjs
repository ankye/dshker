import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { sha256NodeHeaders } from '../../tools/node-runtime-integrity.mjs'

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
  const nodeExecutable = path.join(
    runtimeRoot,
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node'
  )
  assert.equal(launcher.executable, nodeExecutable)
  assert.deepEqual(launcher.prefixArguments, [
    '--expose-internals',
    path.join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs')
  ])
  assert.equal(launcher.commandSearchPath.split(path.delimiter)[0], path.join(runtimeRoot, 'bin'))

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const contextProbe = spawnSync(
    nodeExecutable,
    [
      '--expose-internals',
      '-e',
      "if (process.versions.electron) process.exit(3); require('internal/modules/esm/loader'); process.stdout.write(process.versions.node)"
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      env: environment
    }
  )
  assert.equal(contextProbe.status, 0, contextProbe.stderr)
  const result = spawnSync(nodeExecutable, [...launcher.prefixArguments, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    env: {
      ...environment,
      PATH: launcher.commandSearchPath
    }
  })
  assert.equal(result.status, 0, result.stderr)
  const descriptor = JSON.parse(readFileSync(path.join(runtimeRoot, 'versions.json'), 'utf8'))
  assert.equal(descriptor.schemaVersion, 3)
  const nodeHeaders = path.join(runtimeRoot, 'include', 'node')
  assert.equal(sha256NodeHeaders(nodeHeaders), descriptor.nodeHeadersSha256)
  assert.equal(result.stdout.trim(), descriptor.pnpm)
  mkdirSync('.run/pnpm-startup-repair', { recursive: true })
  const evidencePath = '.run/pnpm-startup-repair/bundled.json'
  mkdirSync(path.dirname(evidencePath), { recursive: true })
  writeFileSync(
    evidencePath,
    JSON.stringify({
      status: result.status,
      version: result.stdout.trim(),
      executable: nodeExecutable,
      nodeContextProbe: contextProbe.stdout.trim(),
      schemaVersion: descriptor.schemaVersion,
      pnpm: descriptor.pnpm,
      nodeHeadersSha256: descriptor.nodeHeadersSha256
    })
  )
  console.log('Real bundled pnpm probe passed:', result.stdout.trim())
} finally {
  rmSync(directory, { recursive: true, force: true })
}
