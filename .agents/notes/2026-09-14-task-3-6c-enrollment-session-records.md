# Task 3.6c: the enrollment and user-session records move behind the core port

Date: 2026-09-14

## What landed

`PeerCredentialStore` now owns three records, and all three live in the native
provider behind `dshkerd` whenever a core secret port is injected:

| record             | core key                      | legacy file                |
| ------------------ | ----------------------------- | -------------------------- |
| device credential  | `peer-credential:<serviceId>` | `<serviceId>.json`         |
| pending enrollment | `peer-enrollment:<serviceId>` | `<serviceId>.json`         |
| persisted session  | `peer-user-session:<id>`      | `<serviceId>.json.session` |

The credential key and its migration shipped in 3.5; the other two are this
task. The legacy record is one file whose `format` tag says which kind it
holds, so the single read path (`#readRouted`) now consults both core keys in
order and then the file, and migrates whichever kind it finds to that kind's own
key. Migrating per kind matters: without it a machine could read its pending
enrollment from the core while the credential was still written to disk, and
the next load would read the file back as the other kind.

`completeEnrollment` retires the pending key only after the credential write is
proven by read-back, so a provider failure leaves the enrollment resumable
rather than losing it.

## Two behaviours the file gave for free

- **Exclusive publication.** `prepareEnrollment` refused to overwrite an
  existing record because the file was published with `link`. The port's `set`
  overwrites, so the core path now reads first and refuses with
  `p2p.credential_write_failed` when either key already holds a record. A
  repeated enrollment cannot erase the identity it is enrolling.
- **One file, one identity.** `remove` deleted the credential file and left the
  session sidecar on disk, so a removed coordinator's session token outlived the
  removal. Both paths now delete every record of that identity.

## A bug this found

`saveUserSession` published its sidecar **exclusively**. Every successful login
or renewal calls it, so the second one silently failed and kept whatever token
was written first; the next restart presented that stale token, the server
refused it, and the user was asked for a password again despite having just
signed in. That is exactly the "why do I have to do this by hand every time"
behaviour this phase exists to remove, so both paths are now an upsert, and
`assertUserSession` guarantees a session can never be stored in a shape the
next load would refuse to return.

One detail worth keeping: the session is validated **inside** the promise, not
before it. The caller in `management.ts` attaches `.catch()` to the returned
promise, and a synchronous throw would escape that and fail the whole login
rather than just the persistence step.

## Verification

- `electron/main/p2p/credential-migration.test.ts`: 14 cases (was 7). New: the
  pending kind migrates to its own key exactly once and never to the credential
  key; an enrollment held by the provider completes and retires the pending key;
  a second enrollment is refused both before and after completion; a failed
  credential write leaves the enrollment resumable; a renewed session replaces
  the first token; a legacy session file migrates once and is cleared; removing
  one identity deletes every record; a session no load could return is refused.
- `electron/main/core/secrets-core.test.ts`: 2 cases against the real `dshkerd`
  and the platform provider. The new one writes the enrollment and session files
  exactly as the previous release did, migrates both, completes the enrollment,
  restarts the core, and reads the credential and the session back from the
  provider alone — then proves `remove` clears all three.
- macOS: `type-check`, `format:check`, `architecture:check` and the full unit
  suite (153 files, 1271 tests) pass.
- Windows, against the real `dshkerd.exe` and DPAPI: the same suite passes (153
  files / 1269 passed / 2 skipped), and with `DSHKER_CORE_BINARY` set the 26
  focused cases — all 14 migration cases, both real-core `secrets-core` cases and
  the 10 supervisor cases — pass in 3.4 s.
- Go is untouched by this task, so the Go suite result recorded for 3.6b stands.
