import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledPnpmEntry, resolvePnpmLauncher } from './pnpm-launcher'
import { resolvePnpmCommand } from './managed/launcher-harness-commands'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createRuntime(overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'launcher runtime '))
  roots.push(root)
  mkdirSync(path.join(root, 'bin'), { recursive: true })
  mkdirSync(path.join(root, 'include', 'node'), { recursive: true })
  mkdirSync(path.join(root, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), '')
  writeFileSync(path.join(root, 'LICENSE.node'), 'Node license')
  writeFileSync(path.join(root, 'include', 'node', 'node_api.h'), 'Node API headers')
  writeFileSync(path.join(root, 'include', 'node', 'node.h'), 'Node headers')
  writeFileSync(path.join(root, 'include', 'node', 'node_version.h'), 'Node version headers')
  writeFileSync(path.join(root, 'pnpm', 'bin', 'pnpm.mjs'), '')
  const archivePlatform = process.platform === 'win32' ? 'win' : process.platform
  const archiveExtension = process.platform === 'win32' ? 'zip' : 'tar.gz'
  writeFileSync(
    path.join(root, 'versions.json'),
    `${JSON.stringify({
      schemaVersion: 3,
      platform: process.platform,
      arch: process.arch,
      node: '22.23.3',
      nodeArchive: `node-v22.23.3-${archivePlatform}-${process.arch}.${archiveExtension}`,
      nodeArchiveSha256: 'a'.repeat(64),
      nodeBinarySha256: 'b'.repeat(64),
      nodeHeadersSha256: 'c'.repeat(64),
      pnpm: '11.7.0',
      ...overrides
    })}\n`
  )
  return root
}

describe('the required staged bundled runtime', () => {
  it('runs pinned pnpm on the matching standalone Node binary', () => {
    const root = createRuntime()
    const launcher = resolvePnpmLauncher(root)
    const nodeExecutable = path.join(
      root,
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    const pnpmEntry = path.join(root, 'pnpm', 'bin', 'pnpm.mjs')

    expect(launcher.resolutionError).toBeUndefined()
    expect(launcher.executable).toBe(nodeExecutable)
    expect(launcher.prefixArguments).toEqual(['--expose-internals', pnpmEntry])
    expect(launcher.commandSearchPath.split(path.delimiter)[0]).toBe(path.join(root, 'bin'))
    expect(bundledPnpmEntry(root)).toBe(pnpmEntry)
    expect(resolvePnpmCommand('', launcher, ['--version'])).toEqual({
      executable: nodeExecutable,
      arguments: ['--expose-internals', pnpmEntry, '--version']
    })
  })

  it('refuses an absent stage instead of resolving system tools', () => {
    const launcher = resolvePnpmLauncher()
    expect(launcher.executable).toBe('')
    expect(launcher.prefixArguments).toEqual([])
    expect(launcher.commandSearchPath).toBe('')
    expect(launcher.resolutionError).toContain(
      'bundled Node/pnpm runtime is unavailable or invalid'
    )
    expect(() => resolvePnpmCommand('', launcher, ['--version'])).toThrow(
      'bundled Node/pnpm runtime is unavailable or invalid'
    )
  })

  it.each([
    ['unknown descriptor schema', { schemaVersion: 4 }],
    ['wrong target', { arch: 'wrong-arch' }],
    ['wrong Node version', { node: '24.21.0' }],
    ['invalid source digest', { nodeArchiveSha256: 'invalid' }],
    ['invalid binary digest', { nodeBinarySha256: '' }],
    ['invalid headers digest', { nodeHeadersSha256: '' }],
    ['missing pnpm version', { pnpm: '' }]
  ])('refuses a stage with %s', (_state, overrides) => {
    const root = createRuntime(overrides)
    expect(bundledPnpmEntry(root)).toBeUndefined()
    expect(resolvePnpmLauncher(root).resolutionError).toContain(
      'bundled Node/pnpm runtime is unavailable'
    )
  })

  it('refuses a stage missing its standalone Node executable or license', () => {
    const root = createRuntime()
    rmSync(path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
    expect(bundledPnpmEntry(root)).toBeUndefined()
  })

  it('refuses a stage missing required Node build headers', () => {
    const root = createRuntime()
    rmSync(path.join(root, 'include', 'node', 'node_api.h'))
    expect(bundledPnpmEntry(root)).toBeUndefined()
  })
})
