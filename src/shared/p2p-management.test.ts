import { describe, expect, it } from 'vitest'
import { P2P_MANAGEMENT_ERROR_CODES } from './p2p-management'

// Task 3.8: a refusal the core can send must be a code the shell can name, and
// therefore localize. These are the families the daemon is proven to keep
// distinguishable in networking/integration/failure_codes_test.go; a code that
// stops appearing here would reach the renderer as a raw string.
describe('P2P failure vocabulary', () => {
  it('names every distinguishable failure the core reports', () => {
    for (const code of [
      'p2p.pair_unauthorized',
      'p2p.user_unauthorized',
      'p2p.network_revoked',
      'p2p.not_connected',
      'p2p.peer_offline',
      'p2p.direct_unavailable',
      'p2p.runtime_unavailable',
      'p2p.lease_expired',
      'p2p.identity_mismatch',
      'p2p.remote_path_forbidden',
      'p2p.operation_failed'
    ]) {
      expect(P2P_MANAGEMENT_ERROR_CODES).toContain(code)
    }
  })

  it('lists each code once, so a duplicate cannot hide a rename', () => {
    const codes = [...P2P_MANAGEMENT_ERROR_CODES]
    expect(new Set(codes).size).toBe(codes.length)
  })
})
