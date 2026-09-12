# Task 3.5: device credential migration to the native provider

Date: 2026-09-12 (evening session)

## What landed

- `electron/main/core/secrets.ts`: `CoreSecretPort` + `CoreSecrets`, the main-only view of `core.secret_get/set/delete`; the typed `p2p.secret_missing` refusal is translated to a miss, never a channel failure.
- `electron/main/p2p/credentials.ts`: `PeerCredentialStore` accepts an optional port. With a live core, loads read the provider first; a legacy `safeStorage` record migrates once (read → write → verify by byte read-back → unlink the file); `create`/`replace`/`completeEnrollment`/`remove` route to the provider and clear the legacy file, so the two stores never diverge. Pending enrollments and user sessions stay legacy until 3.6.
- `electron/main.ts`: `CoreSupervisor` starts at app ready with `dataRoot = <launcherRoot>/core-data`, injects `CoreSecrets` into `PeerManagement`, and degrades to the legacy credential path when the core cannot start (this also completes the production quit wiring: the core is terminated in `shutdownLauncherOwners`).

## Defect found and fixed

The real-core migration test exposed that the macOS Keychain provider (`security add-generic-password -w`) reads at most **128 bytes** per item and **silently truncates** longer input; raw binary is also mangled (the reader is a text channel). A device credential is ~1KB JSON, so every stored credential would have been corrupt. Task 3.2's original verification used a short value and missed it.

Fix in `networking/internal/secret/store_darwin.go`: values are base64-encoded and stored as numbered chunks (`<key>#00…`, chunk size 96) with a header item written last as the commit marker; `Get` reports `ErrMissing` without a header; `Delete` removes header and chunks. `TestKeychainLargeValues` pins sizes 1…2048 with overwrite and delete.

## Verification

- mac: full TS suite 1231 tests; type/architecture/format gates; `secrets-core.test.ts` runs the real `dshkerd` (rebuilt with the fix) through migrate → core restart → provider-persisted load; Go `internal/secret` incl. the new large-value cases.
- win: Go suites via `D:\work\dshker\win35.bat`; TS evidence from the CI windows runner on push.

## Files

- `electron/main/core/secrets.ts` (new), `secrets-core.test.ts` (new)
- `electron/main/p2p/credentials.ts`, `credential-migration.test.ts` (new)
- `electron/main.ts`, `electron/main/launcher-shutdown.ts`, `electron/main/p2p/management.ts`
- `networking/internal/secret/store_darwin.go`, `store_darwin_test.go`

Next: 3.6 (move the device catalog, pairing, and connection state machine into the core and delete the Electron writers).
