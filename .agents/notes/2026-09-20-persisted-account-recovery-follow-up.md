# Persisted account recovery after restart/install — 2026-09-20

## Symptom

After reopening the Launcher, the account pane could show the login form even
though the previous installation had a saved user session.

## Cause

`restoreUserSession` converted every credential-store read failure into
`undefined`. The following `currentUser` request then correctly returned
`p2p.user_login_required` for an in-memory session that had never been adopted,
but the UI could not distinguish that transient provider failure from an
authoritative logout.

## Repair

- Preserve typed credential-provider/transport failures; only an actually absent
  record continues as “no saved session”.
- Display explicit restoration progress while `currentUser` is pending.
- Re-read the account when the main process announces that startup service
  restoration changed; a confirmed signed-out state is not retried silently.
- Share concurrent built-in-service provisioning and durable registration reads so
  the network, account, join, and enrollment panels do not race or duplicate the
  first startup read.
- Publish an in-memory login only after the session has been written through the
  credential provider. The management hook no longer swallows a secret-write
  failure, so a login that cannot survive a restart is reported as failed instead
  of looking successful until the next launch.
- During an explicit pair reconciliation or connect request, repair a closed or
  superseded coordinator signal subscription before starting the pair attempt.
  Healthy subscriptions are left alone, while a displaced daemon can recover
  without restarting the whole Launcher.

## Validation

- `npm test -- --run`
- 164 test files, 1,443 tests passed.
- Focused persistence regression: `electron/main/p2p/accounts.test.ts`,
  `electron/main/p2p/session-registry.test.ts`, and
  `electron/main/p2p/management.test.ts` (76 tests passed).
- Focused networking regression: `cd networking && go test ./internal/peersession ./internal/helper ./internal/controlplane`.
- The local macOS arm64 `dshkerd` was rebuilt and restarted; authenticated
  coordinator probes returned heartbeat 200, both pair presences online, and a
  valid pair identity. No Windows-side real connection was run in this checkout.
