// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import fs, {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import {
  NODE_HEADERS_ARTIFACT,
  resolveRuntimeTarget,
  sha256File,
  verifyStagedRuntime
} from './prepare-runtime.mjs'
import { sha256NodeHeaders } from './node-runtime-integrity.mjs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('the pinned standalone Node target', () => {
  it.each([
    ['darwin', 'arm64', 'node-v22.23.3-darwin-arm64.tar.gz'],
    ['darwin', 'x64', 'node-v22.23.3-darwin-x64.tar.gz'],
    ['win32', 'arm64', 'node-v22.23.3-win-arm64.zip'],
    ['win32', 'x64', 'node-v22.23.3-win-x64.zip'],
    ['linux', 'arm64', 'node-v22.23.3-linux-arm64.tar.gz'],
    ['linux', 'x64', 'node-v22.23.3-linux-x64.tar.gz']
  ])('resolves the pinned artifact for %s-%s', (platform, arch, filename) => {
    expect(resolveRuntimeTarget(['--platform', platform, '--arch', arch])).toMatchObject({
      platform,
      arch,
      filename,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nodeHeadersArchive: NODE_HEADERS_ARTIFACT.filename,
      nodeHeadersArchiveSha256: NODE_HEADERS_ARTIFACT.sha256
    })
  })

  it('pins one exact, independently verified headers archive for every platform target', () => {
    expect(NODE_HEADERS_ARTIFACT).toEqual({
      filename: 'node-v22.23.3-headers.tar.gz',
      sha256: 'eff1a7e67736bdf25db421ddaa613ed605f751a7b9fe07fb473ea880d1348987'
    })
  })

  it('refuses unsupported targets and malformed CLI options', () => {
    expect(() => resolveRuntimeTarget(['--platform', 'plan9', '--arch', 'x64'])).toThrow(
      'unsupported Node runtime target: plan9-x64'
    )
    expect(() => resolveRuntimeTarget(['--arch'])).toThrow('--arch requires a value')
    expect(() => resolveRuntimeTarget(['--unknown'])).toThrow('unknown option: --unknown')
  })
})

describe('the runtime hash publication barrier', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad']
  ])('returns the exact digest with its file already closed for %j', (content, digest) => {
    const root = mkdtempSync(path.join(tmpdir(), 'dshker-runtime-hash-'))
    const filePath = path.join(root, 'node.exe')
    writeFileSync(filePath, content)
    const opened = vi.spyOn(fs, 'openSync')
    const closed = vi.spyOn(fs, 'closeSync')
    try {
      expect(sha256File(filePath)).toBe(digest)
      const index = opened.mock.calls.findIndex(([openedPath]) => openedPath === filePath)
      expect(index).toBeGreaterThanOrEqual(0)
      const descriptor = opened.mock.results[index].value
      expect(closed).toHaveBeenCalledWith(descriptor)
      expect(() => fstatSync(descriptor)).toThrowError(expect.objectContaining({ code: 'EBADF' }))
    } finally {
      opened.mockRestore()
      closed.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows immediate stage publication and deletion after hashing the Windows binary', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dshker-runtime-publish-'))
    const stage = path.join(root, '.runtime-stage', 'runtime')
    const published = path.join(root, 'runtime')
    const bin = path.join(stage, 'bin')
    try {
      mkdirSync(bin, { recursive: true })
      writeFileSync(path.join(bin, 'node.exe'), 'abc')
      expect(sha256File(path.join(bin, 'node.exe'))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      )
      renameSync(stage, published)
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(path.join(published, 'bin', 'node.exe'))).toBe(true)
      rmSync(published, { recursive: true })
      expect(existsSync(published)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a missing binary without producing a digest or retaining its directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dshker-runtime-missing-'))
    try {
      expect(() => sha256File(path.join(root, 'node.exe'))).toThrowError(
        expect.objectContaining({ code: 'ENOENT' })
      )
      rmSync(root, { recursive: true })
      expect(existsSync(root)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runtime verification', () => {
  it('fails closed when the stage does not exist', async () => {
    const missingRoot = path.join(tmpdir(), `missing-dshker-runtime-${process.pid}-${Date.now()}`)
    await expect(verifyStagedRuntime(missingRoot, resolveRuntimeTarget([]))).rejects.toThrow(
      `no staged runtime at ${missingRoot}`
    )
  })

  it('requires Node build headers before producing a runtime digest', () => {
    const root = mkdtempSync(path.join(tmpdir(), `dshker-node-headers-${process.pid}-`))
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'node_api.h'), 'Node API headers')
      writeFileSync(path.join(root, 'node.h'), 'Node API headers')
      writeFileSync(path.join(root, 'node_version.h'), 'Node version headers')
      expect(sha256NodeHeaders(root)).toMatch(/^[a-f0-9]{64}$/u)
      rmSync(path.join(root, 'node_api.h'))
      expect(() => sha256NodeHeaders(root)).toThrow('node_api.h')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
