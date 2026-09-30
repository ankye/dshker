// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveRuntimeTarget, verifyStagedRuntime } from './prepare-runtime.mjs'
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
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
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

describe('runtime verification', () => {
  it('fails closed when the stage does not exist', async () => {
    const missingRoot = path.join(tmpdir(), `missing-dshker-runtime-${process.pid}-${Date.now()}`)
    await expect(verifyStagedRuntime(missingRoot, resolveRuntimeTarget([]))).rejects.toThrow(
      `no staged runtime at ${missingRoot}`
    )
  })
})
