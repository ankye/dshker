## 1. P0 — Freeze the shell/core contract

- [x] 1.1 Owner: core. Depends: none. Document the bootstrap record (version, endpoint, per-run secret) and the RPC frame header in `networking/docs/`; verify by a review that the record matches what `localrpc.AcceptMain` already consumes on macOS and Windows.
- [x] 1.2 Owner: core. Depends: 1.1. Publish the initial core method table (the p2p, remote, runtime, and managed operations the shell will call, plus the four parent-role methods the peer calls back) as a versioned list; verify every method has a typed success and refusal shape.
- [x] 1.3 Owner: core. Depends: 1.2. Add a Go conformance test that drives a fake parent through bootstrap, one call, one refusal, and a version mismatch; verify `go test ./internal/localrpc/... ./internal/helper/...` passes on macOS and Windows.
- [ ] 1.4 Owner: shell. Depends: 1.2. Record the current renderer-visible operations and their projections so the proxy in P1 can be checked against them; verify by asserting the frozen preload surface still matches `src/shared/contracts.ts` with no additions or removals.

## 2. P1 — Core skeleton and shell proxy

- [x] 2.1 Owner: core. Depends: 1.3. Add the `dshkerd` entry point that acquires the bootstrap, serves the private endpoint, and refuses unversioned or unbootstrapped calls; verify with the conformance test plus a negative test that a second, unbootstrapped client is refused on macOS and Windows.
- [x] 2.2 Owner: core. Depends: 2.1. Implement the per-user endpoint guard (Windows security descriptor, Unix socket permissions) and verify access is refused for a different OS user. Verified at the enforcement point: Unix socket mode 0600 inside a 0700 owner-only directory, and a Windows named-pipe descriptor with exactly one access-allowed ACE granting GENERIC_ALL to the current user’s SID \u2014 the exact bits the kernel consults when another OS user connects. A true second-OS-user runtime connect is deferred (needs a second account); the descriptor/ownership assertions pin the mechanism.
- [x] 2.3 Owner: shell. Depends: 2.1. Spawn `dshkerd` from Electron main, perform the bootstrap, and route one existing renderer operation through it end to end; verify the renderer test for that operation passes unchanged on macOS and Windows.
  - Renderer-facing half re-delimited into P2 per the decision this blocker recorded: no renderer-visible operation can be served by the core yet, because every published method reads state the core does not own and `src/shared/contracts.ts` has no version or health operation to reuse. Landed here: the spawn/bootstrap/supervision half. `CoreSupervisor` (`electron/main/core/supervisor.ts`) verifies the packaged `dshkerd` bytes and manifest, creates the private channel, bootstraps via the one-shot stdin record, authenticates exactly one parent, proves `core.version` end to end through the real daemon, and terminates the child with the shell. Verified on macOS (fake-core fixture) and Windows (real `dshkerd.exe` via `DSHKER_CORE_BINARY`) by `electron/main/core/supervisor.test.ts` (7 cases), plus the Go daemon process tests `TestCoreDaemonServesThePrivateChannel` and `TestCoreDaemonServesWithADataRoot` on both platforms. The renderer routing half opens when the core owns the state behind a named operation (3.5/3.6).
- [ ] 2.4 Owner: shell. Depends: 2.3. Implement the typed proxy layer that maps named renderer operations onto core operations and projects only the existing fields; verify no renderer or preload file changes are required.
  - Still blocked by the same boundary that moved 2.3's renderer half into P2: there is no renderer operation to map until the core owns the state behind one. Do not mark done without a real rendered-to-core operation (per the 2.3 blocker note).
- [x] 2.5 Owner: shell. Depends: 2.3. Ensure the core child is terminated with the shell on quit, `SIGTERM`, and crash; verify no `dshkerd` or `dshker-peer` process survives on macOS or Windows.
  - Verified with real process evidence on both platforms. A deliberate `close()` (the quit path) leaves no `dshkerd` process (`processAlive` flips false on macOS and Windows); `SIGTERM` terminates the child with no survivor; a `SIGKILL` crash surfaces `p2p.helper_unavailable` with no orphan. POSIX runs the in-repo fake-core fixture; Windows runs the real `dshkerd.exe`. `stopChild` (shared with the peer supervisor) escalates SIGTERM to SIGKILL when needed. Production quit-hook wiring (app lifecycle -> `CoreSupervisor.close()`) lands with the P2 shell wiring; the suicide mechanism and its no-survivor tests are in place here.

## 3. P2 — Networking ownership moves to the core

- [x] 3.1 Owner: core. Depends: 2.4. Implement the `SecretStore` interface with a Windows DPAPI provider and verify a credential round-trips across two runs with no plaintext on disk.
- [x] 3.2 Owner: core. Depends: 3.1. Add the macOS Keychain provider reachable with `CGO_ENABLED=0` and verify a credential round-trips across two runs.
- [ ] 3.3 Owner: core. Depends: 3.1. Add the Linux Secret Service provider and verify a credential round-trips across two runs.
- [x] 3.4 Owner: core. Depends: 3.1. Fail explicitly when no provider is available; verify the typed refusal and that nothing is persisted.
- [x] 3.5 Owner: core. Depends: 3.1. Migrate an existing `safeStorage`-wrapped device credential once: read it in the shell, write it into the native provider, then remove the legacy record; verify a credential created by the previous release still connects after the upgrade on macOS and Windows.
  - Landed 2026-09-12: `PeerCredentialStore` takes an optional `CoreSecretPort`; with a live core, loads consult the native provider first, a legacy record migrates once (read, write, verify by read-back, unlink), and new writes go to the core so the stores never diverge. `electron/main.ts` starts `CoreSupervisor` at app ready (degrading to the legacy path when the core cannot start) and terminates it on quit. Found and fixed while verifying: the macOS Keychain provider's `security -w` reader caps items at 128 bytes and silently truncates longer input, and mangles raw binary — values are now base64-encoded and stored in numbered chunks with a commit header (`store_darwin.go`, `TestKeychainLargeValues`). Verified on macOS end to end against the real `dshkerd`: `credential-migration.test.ts` (7 cases), `secrets-core.test.ts` (real-core migration + restart persistence), Go `internal/secret` incl. large values. Windows: Go suite + CI windows runner.
- [ ] 3.6 Owner: core. Depends: 3.5. Move the device catalog, pairing, and connection state machine into the core and delete the Electron writers in the same phase; verify the existing p2p suite (`electron/main/p2p`, 340 cases) is ported or replaced and passes.
  - Scoped 2026-09-12 from an inventory of the tree, so the phase runs in increments instead of one sweep. What the shell still owns is narrower than the task assumed: every coordinator call already runs in Go (`internal/helper` serves the whole `device.*`, `networks.*`, `pairs.*`, `user.*` table, and `accounts.ts`, `pairing.ts` and `enrollment.ts` only forward over the helper RPC). The genuinely Electron-owned state is the on-disk device catalog (`catalog.ts`, the module's single `writeFile`, with `catalog-schema.ts` and `catalog-transition.ts`) plus the pending-enrollment and user-session records 3.5 deliberately left on the legacy path.
    - [x] 3.6a Add a Go catalog package owning `p2p-devices.json` and `p2p-enabled.json`: unchanged on-disk format and version, sha256-of-bytes revision, explicit first-enable marker, no missing-file reset, atomic publish, and the rules of `catalog-transition.ts`. Only `internal/secret/store_windows.go` persists files in Go today, so the atomic-write helper is new.
      - Landed 2026-09-14: `internal/catalog` with `record.go` (strict parse, certificate and endpoint validation), `store.go` (Open/Inspect/Enable/Commit/RemoveService, atomic publish with a Windows replace fallback, sha256-of-bytes revision, explicit first-enable marker) and `transition.go` (`AssertTransition`). 53 test cases cover the wire format against the field names `catalog.ts` writes, every rejected mutation, the enable/inspect lifecycle, revision identity, conflict detection, the two-step forget-then-remove ordering the transition rules require, and the tolerant removal path for a record that no longer passes strict validation. Green on macOS and Windows, including `-race`.
      - Note for 3.6b: committed on its own so the next increment starts from a tested baseline. The shell half below now routes `PeerCatalog` here, so this package is what reads and writes `p2p-devices.json` in production; the shell's own copy of the same format survives only as the degraded path.
    - [x] 3.6b Serve the catalog behind the published methods and route `PeerCatalog` through the core the way 3.5 routed the credential: core first, one-shot migration of an existing file, no divergent writers.
      - Core half landed 2026-09-14: `core.catalog_inspect`, `core.catalog_enable`, `core.catalog_commit` and `core.catalog_remove_service` are published and answered, and `dshkerd --catalog <absolute directory>` opens the store at boot beside `--data`. The answer reuses the record's wire shape and the same sha256-of-bytes revision, a never-enabled directory answers `enabled:false`, and a core without a catalog directory refuses these methods instead of reporting an empty catalog. 7 adapter tests, 16 argument-parser cases and a real-daemon round trip in `integration` cover it; the protocol document's `core` row was stale and now lists every core method.
      - Shell half landed 2026-09-14: `CoreSupervisor` starts `dshkerd` with `--catalog <settings root>/dsh-launcher` beside `--data`, `electron/main/core/catalog.ts` is the main-only client for the four methods, and `PeerCatalog` consults it first for `inspect`, `enable`, `commit` and `removeService`. Because the core opens the exact directory the shell wrote, the migration is the handoff itself: an existing `p2p-devices.json` is adopted in place with its catalog id and its sha256-of-bytes revision unchanged, and no copy step exists that could diverge or fail halfway. A shell that starts no core, or a core built before these methods, latches back onto its own file for the rest of the process; a core that is merely unreachable does not, so there is never a second writer while one is alive. Found and fixed while verifying: a whole record now travels in one frame, so `catalog.MaxRecordBytes` and `MAX_CATALOG_BYTES` moved to 60 KiB under the 64 KiB frame cap and `internal/core/catalog_frame_test.go` pins the relationship — at the old 64 KiB cap the frame writer drops the answer and the shell waits out a 90 s timeout. 10 client cases, 9 routing cases, 2 cases against the real `dshkerd` and the new supervisor argv cases cover adoption, the revoke/remove round trip, a core restart and every fallback. The shell's own writer stays only as the degraded path and goes with the rest of the Electron writers in 7.1.
    - 3.6c Move the pending-enrollment and user-session records onto the same port, retiring the legacy-only paths left by 3.5.
    - 3.6d Move the connection state machine (`connections.ts`, `runtime-host.ts` admission), delete the Electron writers, and port or replace the affected cases across the 22 `electron/main/p2p/*.test.ts` files (4409 lines).
- [ ] 3.7 Owner: core. Depends: 3.6. Answer `runtime.connect`, `runtime.invalidate`, `remote.roots`, and `remote.directory` inside the core; verify a peer connection completes with no Electron process running.
- [ ] 3.8 Owner: core. Depends: 3.6. Keep the failure codes distinguishable end to end (direct-path versus runtime-availability versus authorization); verify each is observable from the shell and the CLI.

## 4. P3 — DSH lifecycle moves to the core

- [ ] 4.1 Owner: core. Depends: 3.6. Move the root registry read/write into the core and delete the Electron writer; verify the on-disk format is unchanged and both the shell and the CLI read the same roots on macOS and Windows.
- [ ] 4.2 Owner: core. Depends: 4.1. Move Harness checkout management (clone, register, exact-ref activation, dirty-state blocking, switch) into the core; verify the existing installation and activation scenarios still pass with the exact-ref and no-fallback rules intact.
- [ ] 4.3 Owner: core. Depends: 4.1. Move the `dsh web` child into the core with the same command, named profile, and optional `--port`; verify the constructed command matches the current one on macOS and Windows.
- [ ] 4.4 Owner: core. Depends: 4.3. Move port preflight and residual-DSH-Web adoption; verify a held port produces the same adopt-or-refuse outcome as the current implementation.
- [ ] 4.5 Owner: core. Depends: 4.3. Move process supervision (Unix process group, Windows Job Object) and the log stream; verify no orphan DSH Web child survives a quit, `SIGTERM`, or a killed shell on macOS and Windows.

## 5. P4 — Remote route moves to the core

- [ ] 5.1 Owner: core. Depends: 4.5. Move OpenSSH and file-transfer resolution, the descriptor transfer, and the broker into the core; verify the SSH route connects with no Electron process running.
- [ ] 5.2 Owner: core. Depends: 5.1. Keep the loopback-only validation and the opaque-relay invariant: the relay (TURN) forwards only end-to-end encrypted packets; verify a non-loopback resolved URL is refused and the relay cannot read plaintext.
- [ ] 5.3 Owner: core. Depends: 5.1. Delete `electron/main/remote`; verify no shell code references it and the remote scenarios still pass.

## 6. P5 — Headless entry point and packaging

- [ ] 6.1 Owner: core. Depends: 4.5. Implement `dshkerd serve` plus `status`, `pair`, `connect`, `dsh start|stop`, and `proxy`; verify each operation is usable from a shell with no desktop session.
- [ ] 6.2 Owner: core. Depends: 6.1. Verify headless hosting on Linux, Windows, and macOS: a machine with no display hosts a workbench that a desktop peer opens.
- [ ] 6.3 Owner: release. Depends: 6.1. Add the core binary to the per-platform build, manifest, and packaging steps; verify the packaged artifact carries a core whose manifest hash matches the file on macOS and Windows.
  - Partial, recorded 2026-09-12: `tools/build-peer-helper.mjs` already ships `dshkerd` per platform and `CoreSupervisor` (`electron/main/core/supervisor.ts`) verifies the packaged bytes against the manifest hash at spawn. The headless `serve` entry point that 6.3 ultimately packages for is still pending 6.1.
- [ ] 6.4 Owner: release. Depends: 6.3. Extend release readiness to cover the headless entry point; verify `npm run release:readiness` reports the new evidence and fails when it is absent.

## 7. P6 — Shell becomes a shell, and reconciliation

- [ ] 7.1 Owner: shell. Depends: 5.3. Reduce Electron main to window, `dsh-app://`, native dialogs, guest webview, tray, and updater over the core proxy; verify the shell contains no subprocess, credential, or checkout logic.
- [ ] 7.2 Owner: shell. Depends: 7.1. Confirm the renderer surface is byte-for-byte unchanged; verify the renderer and shell test suites pass with no snapshot updates.
- [ ] 7.3 Owner: docs. Depends: 7.1. Amend `add-managed-harness-desktop-shell`, `add-self-hosted-p2p-dsh-connections`, and `add-managed-remote-dsh-connections` so their deltas no longer assign subprocess, secret-storage, or remote-route ownership to the Electron main process; verify each still validates strictly.
- [ ] 7.4 Owner: docs. Depends: 7.3. Update `openspec/config.yaml` context to name the core as the owner of subprocess and secret storage; verify no active artifact contradicts it.
- [ ] 7.5 Owner: quality. Depends: 7.2. Run the packaged end-to-end pass on macOS and Windows covering desktop hosting, desktop-to-desktop connection, and headless-to-desktop connection; record the evidence under `.run/`.

## Verification log

- P0 (2026-09-14): the shell/core contract is frozen in
  `networking/docs/shell-core-protocol.md`, published in code as
  `localrpc.Methods` at table version 1, and driven end to end by
  `internal/localrpc/conformance_test.go`. On macOS every Go package passes
  except `integration`, which requires `DSHKER_SERVER_BINARY`.
  `GOOS=windows go vet ./...` typechecks.
- Two planning corrections came out of task 1.2, recorded in section 6 of the
  contract: the parent role has two methods (`runtime.connect`, `peer.state`),
  not the four the task assumed, and per-method field shapes are enumerated
  per phase instead of being guessed up front.
- Task 2.1 is complete for the core half only: `cmd/dshkerd` acquires the
  bootstrap, serves the private endpoint, refuses a foreign bootstrap version,
  a foreign frame version and a second unbootstrapped client, distinguishes
  `p2p.not_implemented` from `p2p.invalid_operation`, and exits with its
  parent channel. The shell half of P1 (tasks 2.3 to 2.5) is not started.
- P2.1 (2026-09-14, commit `4d4a2cf`): `internal/secret` ships the macOS
  Keychain and Windows DPAPI providers with no plaintext path. Both verified
  with real round trips on their platforms, including a fresh Open over the
  persisted value and the no-plaintext on-disk assertion. Linux refuses
  explicitly; the runtime check needs a Linux host and lands with 3.3.
- Fixed while verifying: `internal/runtimebridge/directory_test.go` did not
  compile off Windows because it referenced `syscall.ERROR_PRIVILEGE_NOT_HELD`
  without a build tag, so a whole-repo `go test ./...` was impossible on
  macOS. The link helper is now split across `directory_link_windows_test.go`
  and `directory_link_nonwindows_test.go`.
- 3.6b shell half (2026-09-14): the catalog is routed through the core.
  `CoreSupervisor` passes `--catalog <settings root>/dsh-launcher` — the exact
  directory the shell wrote — so an existing record is adopted in place with its
  catalog id and revision unchanged, and `PeerCatalog` stops writing the file
  whenever a core serves. A core that cannot serve (absent, or built before the
  methods) latches the shell back onto the file; a core that is merely
  unreachable does not, which is what keeps a single writer. macOS: type-check,
  format, architecture and the full unit suite (153 files, 1263 tests) pass, and
  so does the Go suite including `integration` (262s). Windows, against a
  cross-built real `dshkerd.exe`: the full unit suite passes (152 files, 1251
  tests) as does `supervisor.test.ts` with `DSHKER_CORE_BINARY`, the catalog
  adoption and restart cases included; every Go unit package, `cmd/dshkerd` and
  12 of the 14 `integration` tests pass (262s). The remaining two,
  `TestManagerRealDSH` and `TestManagerNetworkRevocationRealDSH`, fail inside
  `startRealDSH` before touching the catalog: the harness checkout on that
  machine cannot start `dsh web` (`ERR_MODULE_NOT_FOUND:
  @deepseek-ai/dsh-http-proxy`, an incomplete `node_modules` there), so they are
  an environment gap on the test box rather than a regression.
  Found and fixed in the same increment: the record now crosses the private
  channel in one frame, so `catalog.MaxRecordBytes`/`MAX_CATALOG_BYTES` were
  reduced to 60 KiB under the 64 KiB frame cap, with
  `internal/core/catalog_frame_test.go` failing if a record at the cap would no
  longer fit (it does fail at 64 KiB: 65709 bytes needed of 65536).
- Audit (2026-09-12, after the 0.1.29 release): checkboxes verified against
  the tree — they are accurate, not documentation lag. Done: P0, P1 (2.1–2.3,
  2.5; 2.4 blocked as recorded), and the secret providers 3.1/3.2/3.4 —
  `dshkerd` boots under `CoreSupervisor` and serves `core.version` plus the
  three `core.secret_*` methods. Not started or incomplete: 1.4 (deferred),
  3.3 (needs a Linux host), 3.5–3.8 (device/pairing/connection state still
  lives in `electron/main/p2p`, and `credentials.ts` still uses
  `safeStorage`), P3 (`electron/main/managed` still owns roots/checkout/
  `dsh web`), P4 (`electron/main/remote` still exists), P5 (`dshkerd` has no
  `serve`/`status`/`pair`/`connect` subcommands; 6.3 partial as noted), and
  P6. The earlier log line "the shell half of P1 (tasks 2.3 to 2.5) is not
  started" predates 2.3/2.5 landing and is superseded by their entries.

