// @vitest-environment node
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    // The resolver canonicalises through realpathSync, which on macOS maps
    // /var to /private/var. Compare against the same canonical form so the
    // assertion tests the resolution rather than this machine's symlink layout.
    expect(launcher.executable).toBe(path.join(realpathSync(bin), 'node.exe'))
    expect(launcher.prefixArguments).toEqual([realpathSync(script)])
    expect(resolvePnpmCommand('', launcher, ['--version']).arguments).toEqual([
      realpathSync(script),
      '--version'
    ])
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

describe('a candidate that cannot be inspected', () => {
  // One bad entry must not end the search.
  //
  // The resolver called realpathSync on a discovered shim without guarding it, so
  // a shim behind a link this session cannot follow threw out of the whole
  // function. Every later directory — including one holding a working pnpm — was
  // then never examined, and the launcher reported no runnable pnpm at all. The
  // refusal only surfaced later, as a DSH launch rejected for an unavailable
  // pnpmExecutable, which read to the user as a coordinator problem.
  it('keeps searching later directories and still resolves a usable pnpm', () => {
    const broken = mkdtempSync(path.join(tmpdir(), 'pnpm broken '))
    directories.push(broken)
    // A shim that exists but names a script that does not: readable, unusable.
    writeFileSync(path.join(broken, 'pnpm.cmd'), '@"%~dp0\\node_modules\\pnpm\\bin\\pnpm.mjs" %*')

    const working = createBin()
    const script = path.resolve(working, 'node_modules/pnpm/bin/pnpm.mjs')
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, '')
    writeFileSync(path.join(working, 'pnpm.cmd'), '@"%~dp0\\node_modules\\pnpm\\bin\\pnpm.mjs" %*')

    const launcher = resolveWindowsPnpmLauncher([broken, working])
    expect(launcher.resolutionError).toBeUndefined()
    expect(launcher.executable).toBe(path.join(realpathSync(working), 'node.exe'))
    expect(launcher.prefixArguments).toEqual([realpathSync(script)])
  })

  // A failure has to say where it looked: the same sentence with no list left the
  // user and the maintainer with the same unanswerable question.
  it('names every directory it searched when nothing is runnable', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'pnpm empty '))
    directories.push(empty)
    const launcher = resolveWindowsPnpmLauncher([empty])
    expect(launcher.executable).toBe('')
    expect(launcher.resolutionError).toContain(empty)
  })
})

describe('an installation that keeps its entry script apart from Node', () => {
  // Scoop's layout: the shim and pnpm's entry script live under persist/, and
  // node.exe lives in a versioned app directory reached through a junction.
  //
  // Only the junction was ever searched. A desktop-launched process cannot always
  // follow it, so node.exe appeared to be missing, a working pnpm was discarded,
  // and the launcher reported that none was installed — which refused the DSH
  // launch an inbound connection needs and surfaced to the user as a coordinator
  // failure. Naming the version directory reaches the same node.exe without the
  // link.
  it('resolves when node.exe is only in another searched directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pnpm split '))
    directories.push(root)

    // Where the shim and its script live: no node.exe here.
    const persist = path.join(root, 'persist', 'nodejs', 'bin')
    const script = path.join(persist, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, '')
    writeFileSync(path.join(persist, 'pnpm.cmd'), '@"%~dp0\\node_modules\\pnpm\\bin\\pnpm.mjs" %*')

    // Where Node lives: a separate versioned directory.
    const versioned = path.join(root, 'apps', 'nodejs', '22.22.2')
    mkdirSync(versioned, { recursive: true })
    writeFileSync(path.join(versioned, 'node.exe'), '')

    const launcher = resolveWindowsPnpmLauncher([persist, versioned])
    expect(launcher.resolutionError).toBeUndefined()
    expect(launcher.executable).toBe(path.join(versioned, 'node.exe'))
    expect(launcher.prefixArguments).toEqual([realpathSync(script)])
  })
})
