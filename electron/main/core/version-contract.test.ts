import { describe, expect, it } from 'vitest'
import { assertCoreVersion } from './version-contract'

describe('shell/core state contract version', () => {
  it('accepts only the matched version 2 method/state contract on frame 1', () => {
    expect(() =>
      assertCoreVersion({ version: 1, methodTableVersion: 2, methods: [] })
    ).not.toThrow()
  })

  it.each([
    { version: 1, methodTableVersion: 1, methods: [] },
    { version: 1, methodTableVersion: 3, methods: [] },
    { version: 2, methodTableVersion: 2, methods: [] },
    { version: 1, methods: [] },
    { version: 1, methodTableVersion: 2, methods: 'core.version' },
    { version: 1, methodTableVersion: 2, methods: [], legacy: true }
  ])('refuses incompatible or malformed core contract %o', (version) => {
    expect(() => assertCoreVersion(version)).toThrow(
      expect.objectContaining({ code: 'p2p.protocol_mismatch' })
    )
  })
})
