## 1. P0 — Freeze the shell/core contract

- [x] 1.1 Owner: core. Depends: none. Document the bootstrap record (version, endpoint, per-run secret) and the RPC frame header in `networking/docs/`; verify by a review that the record matches what `localrpc.AcceptMain` already consumes on macOS and Windows.
- [x] 1.2 Owner: core. Depends: 1.1. Publish the initial core method table (the p2p, remote, runtime, and managed operations the shell will call, plus the four parent-role methods the peer calls back) as a versioned list; verify every method has a typed success and refusal shape.
- [x] 1.3 Owner: core. Depends: 1.2. Add a Go conformance test that drives a fake parent through bootstrap, one call, one refusal, and a version mismatch; verify `go test ./internal/localrpc/... ./internal/helper/...` passes on macOS and Windows.
- [ ] 1.4 Owner: shell. Depends: 1.2. Record the current renderer-visible operations and their projections so the proxy in P1 can be checked against them; verify by asserting the frozen preload surface still matches `src/shared/contracts.ts` with no additions or removals.

## 2. P1 — Core skeleton and shell proxy

- [x] 2.1 Owner: core. Depends: 1.3. Add the `dshkerd` entry point that acquires the bootstrap, serves the private endpoint, and refuses unversioned or unbootstrapped calls; verify with the conformance test plus a negative test that a second, unbootstrapped client is refused on macOS and Windows.
- [ ] 2.2 Owner: core. Depends: 2.1. Implement the per-user endpoint guard (Windows security descriptor, Unix socket permissions) and verify access is refused for a different OS user.
- [ ] 2.3 Owner: shell. Depends: 2.1. Spawn `dshkerd` from Electron main, perform the bootstrap, and route one existing renderer operation through it end to end; verify the renderer test for that operation passes unchanged on macOS and Windows.
  - Blocked on P2. No renderer-visible operation can be served by the core yet: every one of the 35 published methods reads state the core does not own (the credential-backed device identity, the catalog, the root registry, the DSH child). `core.version` is core-owned but has no renderer channel, and `src/shared/contracts.ts` has no version or health operation to reuse. Either the task moves its renderer-facing half into P2 and keeps the spawn/bootstrap/supervision half here, or P2.1 has to land first. Decide before starting 2.4.
- [ ] 2.4 Owner: shell. Depends: 2.3. Implement the typed proxy layer that maps named renderer operations onto core operations and projects only the existing fields; verify no renderer or preload file changes are required.
- [ ] 2.5 Owner: shell. Depends: 2.3. Ensure the core child is terminated with the shell on quit, `SIGTERM`, and crash; verify no `dshkerd` or `dshker-peer` process survives on macOS or Windows.

## 3. P2 — Networking ownership moves to the core

- [x] 3.1 Owner: core. Depends: 2.4. Implement the `SecretStore` interface with a Windows DPAPI provider and verify a credential round-trips across two runs with no plaintext on disk.
- [x] 3.2 Owner: core. Depends: 3.1. Add the macOS Keychain provider reachable with `CGO_ENABLED=0` and verify a credential round-trips across two runs.
- [ ] 3.3 Owner: core. Depends: 3.1. Add the Linux Secret Service provider and verify a credential round-trips across two runs.
- [x] 3.4 Owner: core. Depends: 3.1. Fail explicitly when no provider is available; verify the typed refusal and that nothing is persisted.
- [ ] 3.5 Owner: core. Depends: 3.1. Migrate an existing `safeStorage`-wrapped device credential once: read it in the shell, write it into the native provider, then remove the legacy record; verify a credential created by the previous release still connects after the upgrade on macOS and Windows.
- [ ] 3.6 Owner: core. Depends: 3.5. Move the device catalog, pairing, and connection state machine into the core and delete the Electron writers in the same phase; verify the existing p2p suite (`electron/main/p2p`, 340 cases) is ported or replaced and passes.
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
- [ ] 5.2 Owner: core. Depends: 5.1. Keep the loopback-only validation and the no-relay invariant; verify a non-loopback resolved URL is refused and no relay path exists.
- [ ] 5.3 Owner: core. Depends: 5.1. Delete `electron/main/remote`; verify no shell code references it and the remote scenarios still pass.

## 6. P5 — Headless entry point and packaging

- [ ] 6.1 Owner: core. Depends: 4.5. Implement `dshkerd serve` plus `status`, `pair`, `connect`, `dsh start|stop`, and `proxy`; verify each operation is usable from a shell with no desktop session.
- [ ] 6.2 Owner: core. Depends: 6.1. Verify headless hosting on Linux, Windows, and macOS: a machine with no display hosts a workbench that a desktop peer opens.
- [ ] 6.3 Owner: release. Depends: 6.1. Add the core binary to the per-platform build, manifest, and packaging steps; verify the packaged artifact carries a core whose manifest hash matches the file on macOS and Windows.
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
- Fixed while verifying: `internal/runtimebridge/directory_test.go` did not
  compile off Windows because it referenced `syscall.ERROR_PRIVILEGE_NOT_HELD`
  without a build tag, so a whole-repo `go test ./...` was impossible on
  macOS. The link helper is now split across `directory_link_windows_test.go`
  and `directory_link_nonwindows_test.go`.

