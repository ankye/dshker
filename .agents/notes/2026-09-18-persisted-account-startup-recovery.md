# Persisted account startup recovery — 2026-09-18

## Symptom

After an update/restart, the remote account panel could open on the login form
even though the account session had been persisted by the previous Launcher.

## Cause

Startup `goOnline`, the account panel's first `currentUser` read, and the
directory refresh can all reach the same coordinator at once. The account
operation guard allows only one per service. A losing persisted-session restore
was treated as a failed/expired session and removed the durable record, so the
next account read correctly reported signed out even though the failure was only
temporary contention.

## Repair

- `PeerManagement` single-flights persisted-session restore per service and
  clears that in-flight entry when it settles or the helper session is cleared.
- `restoreUserSession` removes the durable session only for explicit
  server-authoritative account refusals (`user_login_required`,
  `user_unauthorized`, `user_session_expired`). Transient helper, transport,
  cancellation and busy errors are rethrown without deleting the record.

## Validation

- `npm test -- --run electron/main/p2p/session-registry.test.ts electron/main/p2p/management.test.ts src/app/shell/tests/P2PAccountPanel.test.ts`
- 3 test files, 60 tests passed.

The packaged-app/update-path and a real coordinator readback remain separate
release gates; this change does not claim those external checks.
