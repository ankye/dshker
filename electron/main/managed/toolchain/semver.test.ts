import { describe, expect, it } from 'vitest'
import {
  nodeVersionSatisfiesRange,
  parseNodeVersionRange,
  parsePnpmPackageManagerDeclaration,
  parseToolchainVersion
} from './semver'

describe('toolchain semantic versions', () => {
  it('accepts the DeepSeek Harness Node declaration without widening either alternative', () => {
    const range = parseNodeVersionRange('^22.19.0 || >=24.0.0')

    expect(nodeVersionSatisfiesRange(parseToolchainVersion('22.19.0'), range)).toBe(true)
    expect(nodeVersionSatisfiesRange(parseToolchainVersion('22.25.4'), range)).toBe(true)
    expect(nodeVersionSatisfiesRange(parseToolchainVersion('23.0.0'), range)).toBe(false)
    expect(nodeVersionSatisfiesRange(parseToolchainVersion('24.0.0'), range)).toBe(true)
  })

  it('treats a partial exact declaration as a bounded minor range', () => {
    const range = parseNodeVersionRange('22.19')

    expect(nodeVersionSatisfiesRange(parseToolchainVersion('22.19.0'), range)).toBe(true)
    expect(nodeVersionSatisfiesRange(parseToolchainVersion('22.19.8'), range)).toBe(true)
    expect(nodeVersionSatisfiesRange(parseToolchainVersion('22.20.0'), range)).toBe(false)
  })

  it('rejects unsupported Node range grammar and non-exact package-manager declarations', () => {
    expect(failureCode(() => parseNodeVersionRange('>=22'))).toBe(
      'toolchain.node_requirement_invalid'
    )
    expect(failureCode(() => parseNodeVersionRange('latest'))).toBe(
      'toolchain.node_requirement_invalid'
    )
    expect(failureCode(() => parsePnpmPackageManagerDeclaration('pnpm@^11.7.0'))).toBe(
      'toolchain.package_manager_invalid'
    )
  })

  it('accepts only an exact pnpm package-manager identity', () => {
    expect(parsePnpmPackageManagerDeclaration('pnpm@11.7.0')).toEqual({
      text: 'pnpm@11.7.0',
      version: { major: 11, minor: 7, patch: 0, text: '11.7.0' }
    })
  })
})

function failureCode(operation: () => unknown): string | undefined {
  try {
    operation()
  } catch (error) {
    return error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  }
  return undefined
}
