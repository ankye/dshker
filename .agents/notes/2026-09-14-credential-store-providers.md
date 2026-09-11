# Credential store providers (P2.1)

Date: 2026-09-14
Change: `openspec/changes/go-owned-headless-core`
Tasks: 3.1, 3.2, 3.4 (Linux Secret Service is 3.3 and is not done)

## What exists

`networking/internal/secret` is the provider-agnostic store: `Store` with
`Get`/`Set`/`Delete`, idempotent delete, and typed `p2p.secret_*` codes that
cross the private channel unchanged. Provider selection is by build tag:

- `store_darwin.go` reaches the Keychain through the system `security` tool
  (CGO_ENABLED=0). The verified incantation and its traps are recorded in
  `.agents/notes/2026-09-14-go-owned-headless-core-p0-p1.md`.
- `store_windows.go` uses `CryptProtectData`/`CryptUnprotectData` from
  `golang.org/x/sys/windows` and keeps one private JSON file under the data
  root, each value DPAPI-encrypted for the current user, written atomically.
- `store_other.go` refuses with `p2p.secret_provider_unavailable` and
  persists nothing, so a headless Linux box cannot silently fall back to a
  readable file.

The core receives the data root as an explicit `--data` argument (recorded in
design D4), which keeps the frozen version 1 bootstrap record untouched.

## Verified

- macOS: real Keychain round trip through `TestKeychainRoundTrip` (set,
  overwrite via -U, read, fresh Open read, delete, idempotent delete).
- Windows: real DPAPI round trip through `TestDPAPIRoundTripAndFreshOpen`,
  including a fresh Open over the persisted file and the no-plaintext
  assertion (the credential bytes do not appear in the blob file), plus the
  refusal without a data root.
- Cross-compile typechecks for darwin, windows and linux.

## Bugs caught while building it

1. `dpapiProtect`/`dpapiUnprotect` returned a slice pointing at the crypt32
   output buffer and `defer LocalFree` freed that buffer before the caller
   saw the value: a use-after-free that corrupted the persisted blob. The
   output is now copied with `bytes.Clone` before the deferred free.
2. `go vet` caught a signature mistake (value vs pointer `DataBlob`) that a
   build on Windows would have caught later.
3. Not a code bug, but expensive: a tar transfer that tarred `internal/secret`
   from inside `networking` but extracted at the app root silently left the
   fix unstaged on the Windows host, so the test kept failing with stale
   code. Transfers now always tar the full `networking/...` path from the app
   root and extract at the app root.

## Not done

3.3 (Linux Secret Service over D-Bus) is untouched; on Linux the store
refuses, which is the designed behavior until the provider lands. Task 3.5
(migrate the `safeStorage`-wrapped credential) cannot start until the shell
spawns the core and routes the credential through it, which is the P1 shell
work (2.3 to 2.5) blocked on the state-ownership decision recorded under
task 2.3.
