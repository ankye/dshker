// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyStagedRuntime } from './prepare-runtime.mjs'

const require = createRequire(import.meta.url)

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The very Electron executable DSHKer runs, the same probe target the script uses. */
function electronExecutable() {
  const executable = require('electron')
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('electron dependency did not resolve its packaged executable path')
  }
  return executable
}

/** The Node version the packaged Electron reports, probed exactly like the script. */
function probedNodeVersion(executable) {
  return execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  }).trim()
}

/** The version of the pinned pnpm devDependency, read exactly like the script. */
function pinnedPnpmVersion() {
  return JSON.parse(readFileSync(require.resolve('pnpm'), 'utf8')).version
}

/** A scratch stage that mirrors the real resources/runtime layout. */
function createStage(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'verify-runtime-'))
  roots.push(root)
  mkdirSync(path.join(root, 'bin'), { recursive: true })
  mkdirSync(path.join(root, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(
    path.join(root, 'pnpm', 'bin', 'pnpm.mjs'),
    `console.log(${JSON.stringify(pinnedPnpmVersion())})\n`
  )
  writeFileSync(
    path.join(root, 'versions.json'),
    `${JSON.stringify(
      {
        schemaVersion: options.schemaVersion ?? 1,
        node: options.node ?? '0.0.0',
        pnpm: options.pnpm ?? pinnedPnpmVersion()
      },
      undefined,
      2
    )}\n`
  )
  return root
}

describe('the staged runtime version gate', () => {
  it('accepts a complete scratch stage that matches the probed pair', () => {
    const executable = electronExecutable()
    const root = createStage({ node: probedNodeVersion(executable) })
    expect(() => verifyStagedRuntime(executable, root)).not.toThrow()
    // Verify mode never rewrites the stage.
    expect(JSON.parse(readFileSync(path.join(root, 'versions.json'), 'utf8')).node).toBe(
      probedNodeVersion(executable)
    )
  })

  it('rejects a stage whose recorded node drifted from the packaged Electron', () => {
    const executable = electronExecutable()
    const root = createStage({ node: '0.0.0' })
    const before = readFileSync(path.join(root, 'versions.json'), 'utf8')
    expect(() => verifyStagedRuntime(executable, root)).toThrow(/does not match/)
    // The refusal must not modify the stage while it is proving the drift.
    expect(readFileSync(path.join(root, 'versions.json'), 'utf8')).toBe(before)
  })

  it('rejects a stage whose descriptor schema is unknown without probing', () => {
    const executable = electronExecutable()
    const root = createStage({ schemaVersion: 2 })
    expect(() => verifyStagedRuntime(executable, root)).toThrow(/unknown schema/)
  })

  it('rejects a stage whose recorded pnpm drifted from the pinned devDependency', () => {
    const executable = electronExecutable()
    const root = createStage({ node: probedNodeVersion(executable), pnpm: '0.0.0' })
    expect(() => verifyStagedRuntime(executable, root)).toThrow(/does not match/)
  })
})
