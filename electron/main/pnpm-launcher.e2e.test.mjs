import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const directory = mkdtempSync(path.join(tmpdir(), 'pnpm-live-'))
try {
  const output = path.join(directory, 'resolver.cjs')
  await build({
    entryPoints: ['electron/main/pnpm-launcher.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output
  })
  const launcher = createRequire(import.meta.url)(output).resolvePnpmLauncher()
  assert.equal(launcher.resolutionError, undefined)
  assert.ok(path.isAbsolute(launcher.executable))
  const result = spawnSync(launcher.executable, [...launcher.prefixArguments, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, PATH: launcher.commandSearchPath }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/u)
  mkdirSync('.run/pnpm-startup-repair', { recursive: true })
  writeFileSync(
    '.run/pnpm-startup-repair/probe.json',
    JSON.stringify({
      status: result.status,
      version: result.stdout.trim(),
      executable: launcher.executable
    })
  )
  console.log('Real installed pnpm probe passed:', result.stdout.trim())
} finally {
  rmSync(directory, { recursive: true, force: true })
}
