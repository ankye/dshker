// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledRuntimeHolds } from './release-smoke.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const manifest = { productName: 'Test App' }

function releaseDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'release-smoke-'))
  roots.push(root)
  return root
}

function stageDescriptor(releaseDir, descriptor) {
  const runtime = path.join(
    releaseDir,
    'mac-arm64',
    `${manifest.productName}.app`,
    'Contents',
    'Resources',
    'runtime'
  )
  mkdirSync(runtime, { recursive: true })
  writeFileSync(path.join(runtime, 'versions.json'), `${JSON.stringify(descriptor)}\n`)
}

describe('the packaged bundled runtime check', () => {
  it('accepts an unpacked build carrying a schemaVersion-1 runtime descriptor', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, { schemaVersion: 1, node: '24.16.0', pnpm: '11.7.0' })
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(true)
  })

  it('rejects an unpacked build whose descriptor schema is unknown', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, { schemaVersion: 2, node: '24.16.0', pnpm: '11.7.0' })
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects an unpacked build whose descriptor is missing the pinned pair', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, { schemaVersion: 1 })
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects a release with no unpacked build carrying the runtime at all', async () => {
    const directory = releaseDir()
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects an unpacked build whose descriptor is not readable JSON', async () => {
    const directory = releaseDir()
    const runtime = path.join(
      directory,
      'mac-arm64',
      `${manifest.productName}.app`,
      'Contents',
      'Resources',
      'runtime'
    )
    mkdirSync(runtime, { recursive: true })
    writeFileSync(path.join(runtime, 'versions.json'), '{broken')
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })
})
