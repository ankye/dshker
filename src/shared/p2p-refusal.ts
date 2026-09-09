import type { P2PManagementErrorCode } from './p2p-management'

/**
 * What a refusal means to the person reading it.
 *
 * The renderer had one generic line for every code, so a rejected email and a
 * broken coordinator produced the same sentence telling the user to check a
 * configuration that was often correct. There are far more codes than anyone
 * will write copy for, so classification is derived from the code itself and a
 * new code lands in the right category without another mapping entry.
 *
 * - `input`: the user can fix it by editing what they typed.
 * - `signedOut`: no session; the sign-in form is the answer.
 * - `absent`: nothing is stored or configured yet. Usually a normal state.
 * - `retry`: transient. The same action can succeed later.
 * - `unconfirmed`: the result is genuinely unknown; never claim either outcome.
 * - `fault`: something is actually wrong and needs the raw code.
 */
export type P2PRefusalKind = 'input' | 'signedOut' | 'absent' | 'retry' | 'unconfirmed' | 'fault'

/**
 * Codes whose surface form would classify them wrongly.
 *
 * Kept deliberately short: each entry is a case where the code's own wording
 * misleads, not a place to enumerate everything.
 */
const OVERRIDES: Readonly<Record<string, P2PRefusalKind>> = {
  // Reads as "invalid" but describes a coordinator that answered incorrectly,
  // which the user cannot fix by retyping anything.
  'p2p.invalid_server_response': 'fault',
  'p2p.invalid_operation': 'fault',
  'p2p.protocol_mismatch': 'fault',
  'p2p.invalid_bootstrap': 'fault',
  // Reads as "not found" but means this device's own record is gone, which is a
  // real problem rather than a not-yet-created state.
  'p2p.credential_invalid': 'fault',
  // A wrong password is input the user retypes, despite naming credentials.
  'p2p.invalid_user_credentials': 'input',
  'p2p.login_failed': 'input',
  // Already logged in is not a fault and not an absence: retrying after the
  // existing session is read succeeds.
  'p2p.user_already_logged_in': 'retry'
}

/** Classifies a refusal so the UI can say something true about it. */
export function p2pRefusalKind(code: P2PManagementErrorCode | string): P2PRefusalKind {
  const override = OVERRIDES[code]
  if (override) return override
  if (code.includes('unconfirmed')) return 'unconfirmed'
  if (
    code.includes('login_required') ||
    code.includes('session_expired') ||
    code.includes('unauthorized')
  )
    return 'signedOut'
  if (code.includes('not_found') || code.includes('unavailable') || code.includes('unconfigured'))
    return 'absent'
  if (
    code.includes('busy') ||
    code.includes('limit') ||
    code.includes('timeout') ||
    code.includes('cancelled') ||
    code.includes('conflict')
  )
    return 'retry'
  if (code.includes('invalid_') || code.includes('too_') || code.includes('required'))
    return 'input'
  return 'fault'
}
