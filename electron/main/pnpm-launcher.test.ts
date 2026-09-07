// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWindowsPnpmLauncher } from './pnpm-launcher'
import { resolvePnpmCommand } from './managed/launcher-harness-commands'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function createBin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pnpm layout '))
  directories.push(root)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'node.exe'), '')
  return bin
}

describe('Windows pnpm installation layouts', () => {
  it.each([
    'node_modules/pnpm/bin/pnpm.mjs',
    '../node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/corepack/dist/pnpm.js'
  ])('resolves the declared shim target %s with shell-free arguments', (relative) => {
    const bin = createBin()
    const script = path.resolve(bin, relative)
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, '')
    writeFileSync(path.join(bin, 'pnpm.cmd'), `@echo off\r\n"%_prog%" "%dp0%/${relative}" %*`)
    const launcher = resolveWindowsPnpmLauncher([bin])
    expect(launcher.executable).toBe(path.join(bin, 'node.exe'))
    expect(launcher.prefixArguments).toEqual([script])
    expect(resolvePnpmCommand('', launcher, ['--version']).arguments).toEqual([script, '--version'])
  })

  it('runs a standalone pnpm executable without a Node script', () => {
    const bin = createBin()
    writeFileSync(path.join(bin, 'pnpm.exe'), '')
    const launcher = resolveWindowsPnpmLauncher([bin])
    expect(launcher.executable).toBe(path.join(bin, 'pnpm.exe'))
    expect(launcher.prefixArguments).toEqual([])
  })

  it('rejects a missing tool before spawning and recovers after installation', () => {
    const bin = createBin()
    expect(() => resolvePnpmCommand('', resolveWindowsPnpmLauncher([bin]), [])).toThrow(
      'No runnable pnpm'
    )
    writeFileSync(path.join(bin, 'pnpm.exe'), '')
    expect(resolveWindowsPnpmLauncher([bin]).resolutionError).toBeUndefined()
  })

  it('rejects a shim whose declared target is missing', () => {
    const bin = createBin()
    writeFileSync(path.join(bin, 'pnpm.cmd'), '"%dp0%/node_modules/pnpm/bin/pnpm.mjs"')
    expect(() => resolvePnpmCommand('', resolveWindowsPnpmLauncher([bin]), [])).toThrow(
      'No runnable pnpm'
    )
  })
})
