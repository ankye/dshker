import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE_HEADERS_ARTIFACT } from './prepare-runtime.mjs'
import { sha256NodeHeaders } from './node-runtime-integrity.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidenceDirectory = path.join(appRoot, '.run', 'node-headers-archive')
const evidencePath = path.join(evidenceDirectory, 'verification.json')
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'dshker-node-headers-'))

try {
  const url = `https://nodejs.org/dist/v22.23.3/${NODE_HEADERS_ARTIFACT.filename}`
  const response = await fetch(url)
  assert.equal(
    response.ok,
    true,
    `official Node headers archive download failed: ${response.status}`
  )
  assert.notEqual(response.body, null, 'official Node headers archive response had no body')

  const archiveBytes = Buffer.from(await response.arrayBuffer())
  const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
  assert.equal(
    archiveSha256,
    NODE_HEADERS_ARTIFACT.sha256,
    'official Node headers archive checksum mismatch'
  )

  const archivePath = path.join(temporaryDirectory, NODE_HEADERS_ARTIFACT.filename)
  writeFileSync(archivePath, archiveBytes)
  execFileSync(
    'tar',
    [
      '-xzf',
      archivePath,
      '--strip-components',
      '1',
      '-C',
      temporaryDirectory,
      'node-v22.23.3/include/node'
    ],
    { windowsHide: true }
  )
  const headersPath = path.join(temporaryDirectory, 'include', 'node')
  const headersTreeSha256 = sha256NodeHeaders(headersPath)

  mkdirSync(evidenceDirectory, { recursive: true })
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        status: 'verified',
        nodeVersion: '22.23.3',
        archive: NODE_HEADERS_ARTIFACT.filename,
        archiveSha256,
        headersTreeSha256,
        requiredHeaders: ['node.h', 'node_api.h', 'node_version.h']
      },
      null,
      2
    )}\n`
  )
  console.log(`NODE_HEADERS_ARCHIVE_E2E_OK ${archiveSha256} ${headersTreeSha256}`)
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
