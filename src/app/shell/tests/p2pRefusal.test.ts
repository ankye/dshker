import { describe, expect, it } from 'vitest'
import { P2P_MANAGEMENT_ERROR_CODES } from '@/shared/p2p-management'
import { p2pRefusalKind } from '@/shared/p2p-refusal'

describe('P2P refusal classification', () => {
  it('classifies every allowed code, so no refusal is left without a category', () => {
    // The point of deriving the category is that a new code cannot silently fall
    // back to a message that tells the user to check a correct configuration.
    for (const code of P2P_MANAGEMENT_ERROR_CODES) {
      expect(p2pRefusalKind(code)).toBeTruthy()
    }
  })

  it("treats a rejected value as the user's to fix", () => {
    expect(p2pRefusalKind('p2p.invalid_request')).toBe('input')
    expect(p2pRefusalKind('p2p.invalid_user_credentials')).toBe('input')
    expect(p2pRefusalKind('p2p.password_too_short')).toBe('input')
  })

  it('separates being signed out from a failure', () => {
    expect(p2pRefusalKind('p2p.user_login_required')).toBe('signedOut')
    expect(p2pRefusalKind('p2p.user_session_expired')).toBe('signedOut')
    expect(p2pRefusalKind('p2p.user_unauthorized')).toBe('signedOut')
  })

  it('separates nothing-stored-yet from something being broken', () => {
    expect(p2pRefusalKind('p2p.credential_unavailable')).toBe('absent')
    expect(p2pRefusalKind('p2p.enrollment_not_found')).toBe('absent')
    // A record that exists but is corrupt is a real fault, despite the wording.
    expect(p2pRefusalKind('p2p.credential_invalid')).toBe('fault')
  })

  it('marks transient refusals as retryable', () => {
    expect(p2pRefusalKind('p2p.service_busy')).toBe('retry')
    expect(p2pRefusalKind('p2p.request_timeout')).toBe('retry')
    expect(p2pRefusalKind('p2p.network_limit_reached')).toBe('retry')
  })

  it('never downgrades an unconfirmed result to a plain failure', () => {
    // Claiming either outcome would be a lie; this category must survive.
    expect(p2pRefusalKind('p2p.management_result_unconfirmed')).toBe('unconfirmed')
    expect(p2pRefusalKind('p2p.enrollment_result_unconfirmed')).toBe('unconfirmed')
  })

  it('does not call a bad server answer an input problem', () => {
    // The user cannot retype anything to fix these, so offering that is wrong.
    expect(p2pRefusalKind('p2p.invalid_server_response')).toBe('fault')
    expect(p2pRefusalKind('p2p.protocol_mismatch')).toBe('fault')
    expect(p2pRefusalKind('p2p.invalid_operation')).toBe('fault')
  })

  it('classifies an unknown future code as a fault rather than throwing', () => {
    // A helper that grows a code must not break the renderer.
    expect(p2pRefusalKind('p2p.some_code_added_later')).toBe('fault')
  })
})
