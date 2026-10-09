// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledRuntimeHolds } from './release-smoke.mjs'
import { sha256NodeHeaders } from './node-runtime-integrity.mjs'

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
  mkdirSync(path.join(runtime, 'bin'), { recursive: true })
  mkdirSync(path.join(runtime, 'include', 'node'), { recursive: true })
  writeFileSync(path.join(runtime, 'bin', 'node'), '')
  writeFileSync(path.join(runtime, 'include', 'node', 'node_api.h'), 'Node API headers')
  writeFileSync(path.join(runtime, 'include', 'node', 'node.h'), 'Node headers')
  writeFileSync(path.join(runtime, 'include', 'node', 'node_version.h'), 'Node version headers')
  const headersDigest = sha256NodeHeaders(path.join(runtime, 'include', 'node'))
  writeFileSync(
    path.join(runtime, 'versions.json'),
    `${JSON.stringify({
      ...descriptor,
      nodeHeadersSha256: descriptor.nodeHeadersSha256 ?? headersDigest
    })}\n`
  )
}

function validDescriptor(overrides = {}) {
  return {
    schemaVersion: 3,
    platform: 'darwin',
    arch: 'arm64',
    node: '22.23.3',
    nodeArchive: 'node-v22.23.3-darwin-arm64.tar.gz',
    nodeArchiveSha256: 'a'.repeat(64),
    nodeBinarySha256: createHash('sha256').update('').digest('hex'),
    pnpm: '11.7.0',
    ...overrides
  }
}

describe('the packaged bundled runtime check', () => {
  it('accepts an unpacked build carrying the pinned standalone runtime', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor())
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(true)
  })

  it('rejects an unpacked build whose descriptor schema is unknown', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor({ schemaVersion: 4 }))
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects an unpacked build whose descriptor is missing the pinned pair', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor({ pnpm: '' }))
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

  it('rejects a bundled Node binary whose digest differs from the descriptor', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor({ nodeBinarySha256: 'b'.repeat(64) }))
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects Node headers whose digest differs from the descriptor', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor({ nodeHeadersSha256: 'b'.repeat(64) }))
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })

  it('rejects a packaged runtime without required Node build headers', async () => {
    const directory = releaseDir()
    stageDescriptor(directory, validDescriptor())
    const headers = path.join(
      directory,
      'mac-arm64',
      `${manifest.productName}.app`,
      'Contents',
      'Resources',
      'runtime',
      'include',
      'node'
    )
    rmSync(path.join(headers, 'node_api.h'))
    expect(await bundledRuntimeHolds(directory, manifest)).toBe(false)
  })
})
