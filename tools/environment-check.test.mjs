import { describe, expect, it } from 'vitest'
import { nodeVersionSatisfies, npmVersionSatisfies } from './environment-check.mjs'

describe('environment check', () => {
  it('accepts the supported Node.js release ranges', () => {
    expect(nodeVersionSatisfies('v20.18.9')).toBe(false)
    expect(nodeVersionSatisfies('v20.19.0')).toBe(true)
    expect(nodeVersionSatisfies('v22.11.0')).toBe(false)
    expect(nodeVersionSatisfies('v22.12.0')).toBe(true)
    expect(nodeVersionSatisfies('v24.0.0')).toBe(true)
  })

  it('accepts npm 10 and newer', () => {
    expect(npmVersionSatisfies('9.9.9')).toBe(false)
    expect(npmVersionSatisfies('10.0.0')).toBe(true)
    expect(npmVersionSatisfies('11.1.0')).toBe(true)
  })
})
