## Purpose

Provide durable automatic sign-in renewal and explicit password recovery for Launcher users while preserving the original account, enrolled device identities, authorized networks and established pair records.

## ADDED Requirements

### Requirement: Launcher renews its existing authenticated session
Launcher SHALL renew the saved session at startup and within seven days of expiry during owned background maintenance, using only the pinned service and the server-returned token and expiry. Renewal MUST be serialized per service and saved/read back before publishing its result.

#### Scenario: Saved or running session approaches expiry
- **WHEN** the original session remains valid on the coordinator
- **THEN** startup or automatic maintenance retains the same account and token with the authoritative renewed expiry across restart, without requesting a password

#### Scenario: Response or persistence fails
- **WHEN** renewal transport or protected storage fails
- **THEN** the existing durable record remains available for an explicit retry and the failure cannot be presented as confirmed sign-out or fabricated renewal success

#### Scenario: Logout or account scope changes during renewal
- **WHEN** a delayed renewal belongs to an ended owner or a changed token
- **THEN** it cannot restore the old session, overwrite a newer login or change a device, network or pair

### Requirement: Password recovery is a named restricted operation
Launcher SHALL offer a signed-out password-reset form requiring email, an administrator-issued one-time code, a new password and confirmation. It MUST admit only the named resetPassword operation and never expose token issuance or generic native access.

#### Scenario: Original account password is reset
- **WHEN** the coordinator confirms a valid email/code/password reset
- **THEN** the form requests manual sign-in with the new password and retains the original account, device, network and pair identity

#### Scenario: Recovery code is invalid or result is unconfirmed
- **WHEN** the code is expired, consumed, wrong-account, or the reset result is lost
- **THEN** actionable feedback is shown without automatically resubmitting or claiming password recovery succeeded

#### Scenario: Secrets leave the form
- **WHEN** a form is submitted, switched or destroyed
- **THEN** password and reset-code drafts are cleared and never persisted or logged

#### Scenario: Confirmed reset leaves a failed native cleanup
- **WHEN** the server confirms the reset but deletion of its exact locally selected session fails
- **THEN** Launcher reports that cleanup failure and revokes the original local owner; only a fresh renewal entry matching that exact revoked token and record reports login required for an explicit cleanup retry, and fresh password authentication can proceed after cleanup recovers without replaying the reset code
