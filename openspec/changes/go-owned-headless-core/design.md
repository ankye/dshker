## Context

See `proposal.md` for motivation and `specs/native-core-daemon/spec.md` for the required behavior. This section records only the current state that shapes the approach.

The seam already exists. Today's Go helper (`networking/`, 31 files / 4,621 LOC) owns the coordinator client (`internal/controlplane`), the P2P session and its ICE/DTLS transport (`internal/peersession`, `internal/peer`), the reverse proxy and remote directory listing (`internal/runtimebridge`), and a private RPC channel (`internal/localrpc`) bootstrapped by one JSON record on the child's stdin. The Electron main process owns the orchestration above it: `electron/main/p2p` (27 files / 5,768 LOC), `electron/main/remote` (6 / 1,447), `electron/main/managed` (43 / 9,689).

Four constraints shape the move:

- The helper cannot run alone: `cmd/dshker-peer` rejects every argument except `--version`, then blocks in `localrpc.AcceptMain` until a parent bootstraps it. Its endpoint is a Unix socket or a Windows named pipe restricted to the owning user's SID, so it has no remote control surface by construction.
- The helper calls back into its parent for the local DSH binding (`runtime.connect`, `runtime.invalidate`) and for authorized roots (`remote.roots`, `remote.directory`). Those four methods are the current parent contract.
- DSH Web is started as `pnpm dsh -- web --no-open`, with `--port` only for a fixed selection, and is bound to loopback. The SSH route forwards `127.0.0.1:local:127.0.0.1:remote` and validates that the resolved URL host is `127.0.0.1` or `localhost`.
- The helper's build already sets `CGO_ENABLED=0` for all six targets, which constrains how a macOS credential provider can be reached.

## Goals / Non-Goals

**Goals:**

- One Go core that can host and reach a DSH workbench with no Electron, no window, and no desktop session on macOS, Windows, and Linux.
- Keep the existing helper process as the untrusted-input boundary, so a defect in the P2P/ICE/DTLS stack does not give an attacker the credential store and the DSH child in the same process.
- Keep the renderer's frozen typed surface byte-for-byte, so no renderer or preload change is required by this move.
- Preserve data on disk: the catalog, credential records, root registry, and launch preferences keep their current formats and locations, or are migrated once with a recorded, reversible step.

**Non-Goals:**

- No relay, TURN, or third-party transit; no new remote-access mode.
- No change to the coordinator protocol, the helper wire protocol, or the DSH CLI contract.
- No attempt to keep two owners of the same store at any point in the migration.

## Decisions

### D1. `dshkerd` is the core; `dshker-peer` stays a child process

The core binary owns the coordinator client, catalog, credentials, the reverse proxy, the SSH route, and the DSH child. It keeps spawning `dshker-peer` as a separate process over the existing bootstrap and private-socket contract rather than linking the peer code in.

Rationale: the peer parses attacker-controlled network input (ICE candidates, SDP, DTLS/SCTP, signal frames). Keeping it separate preserves today's defence in depth and reuses a contract that is already implemented and tested. Linking it in would be less code but would put credential decryption and the DSH child in the same address space as the parser.

Rejected: a single-binary design that embeds `peersession`/`protocol` directly.

### D2. Electron starts `dshkerd` and proxies over the private local channel

Electron main spawns the core, writes one versioned bootstrap record to its stdin (version, socket or pipe name, and a per-run secret), then speaks named JSON-RPC operations over that endpoint. The renderer keeps its current preload surface; main maps named renderer operations onto core operations and projects only what the surface already exposes.

Rationale: this is the pattern the helper already uses, so the trust boundary and the failure modes are known. It also keeps the core off the network — it has no TCP or UDP control listener — and it lets the same binary serve a headless run with no Electron at all.

Rejected: the renderer connecting to the core directly over a local WebSocket (needs a new loopback surface, duplicates admission and projection logic in the renderer, and widens what a compromised renderer can reach). Rejected: stdio-only JSON on the core's own stdin/stdout (the project explicitly forbids restoring an SDK-stdio transport, and it couples the core's lifetime to the shell's pipes).

### D3. Core↔helper and shell↔core are versioned separately

The bootstrap record and every RPC frame carry an explicit protocol version. The core refuses a helper or shell whose version it does not implement, with a typed refusal, instead of degrading.

Rationale: three artifacts now ship together (shell, core, peer) and they can be updated independently on a machine.

### D4. Credentials go to an OS provider selected at build time, with no plaintext path

A `SecretStore` interface has one implementation per platform: Windows DPAPI (`golang.org/x/sys/windows`, pure Go), Linux Secret Service over D-Bus, macOS Keychain. macOS is the constraint: the build is `CGO_ENABLED=0`, so the Keychain is reached through the system `security` tool with the secret supplied on stdin, not argv, or through a small cgo shim if a future build enables cgo. When no provider is usable the core fails explicitly and persists nothing.

Rejected: keeping Electron `safeStorage` (defeats the headless goal). Rejected: an unprotected file store, even behind a flag.

The core receives its data root as an explicit `--data` argument, never an implied default. Windows stores DPAPI-protected blobs under that root (one private file, mode 0600, replaced atomically), and macOS keeps items in the Keychain. The bootstrap record is unchanged, so the frozen version 1 contract stays whole.

### D5. One writer per store, switched by migration step

Each persisted store has exactly one writer during any phase: the root registry, the device catalog, the credential records, and launch preferences. A phase that moves a store to the core also removes the Electron writer in the same phase; no dual-write and no runtime fallback.

### D6. Process supervision keeps the existing semantics

The core supervises the DSH child and the peer with the semantics `electron/main/managed/process-tree.ts` implements today: a Unix process group signalled SIGTERM then SIGKILL, and a Windows Job Object with kill-on-close, so a normal quit, `SIGTERM`, or a crash cannot orphan a DSH Web child. Port preflight and the "adopt a residual DSH Web that this product owns" behavior move with it.

### D7. The peer's parent-role methods move into the core

`runtime.connect`, `runtime.invalidate`, `remote.roots`, and `remote.directory` are answered inside the core. `remote.*` already runs in Go; `runtime.connect` becomes a local lookup of the DSH child the core itself started, so the peer no longer needs the shell to be alive.

### D8. Reconciliation with the in-flight changes

Three active changes still contain requirements that this move contradicts, and none has archived yet:

- `add-managed-harness-desktop-shell` — `harness-runtime-supervision`, `desktop-renderer-authority`, `managed-harness-roots`, `desktop-launcher-experience`, `desktop-launcher-release-readiness`.
- `add-managed-remote-dsh-connections` — `managed-remote-dsh-connections`, which today states that "Electron main SHALL own OpenSSH and file-transfer resolution, subprocess arguments, temporary files, peer secrets, DSH session credentials, HTTP peer calls, persistence, and process shutdown".
- `add-self-hosted-p2p-dsh-connections` — `direct-peer-dsh-sessions`, which assigns the same orchestration to the shell.

These were aligned in this change rather than left to their own archive. The prescriptive sentences that named the Electron main process as the owner of subprocess, Git, filesystem, peer secrets, and process shutdown now state the trust boundary instead — "the trusted core SHALL own …" — so they stay true whichever process implements it, and the renderer-confinement half of each requirement is untouched. Affected: `managed-remote-dsh-connections` (the requirement text), `harness-runtime-supervision` (the quit scenario), `managed-harness-roots` (the rejection outcome), `desktop-launcher-experience` (the child-lifecycle scenario), plus the project context in `openspec/config.yaml`.

This change still adds no MODIFIED delta of its own, because the main spec tree is empty while none of those changes has archived; a MODIFIED delta would have no main-spec requirement to resolve against. `desktop-renderer-authority` and `desktop-launcher-release-readiness` needed no change: their requirements are the renderer surface, the update authority, and packaged evidence, none of which assigns subprocess or secret ownership.

## Risks / Trade-offs

- **Legacy credential migration.** Existing installs have device keys wrapped by Electron `safeStorage` (a Chromium scheme, not a bare Keychain entry). Moving to a native provider requires a one-time read of the legacy blob and a re-wrap. → The migration runs once, in the shell process that can still read the legacy record, writes into the new provider, and only then removes the legacy file; the record format gains a discriminator so an older build cannot silently mis-read it.
- **Two writers on the root registry during migration.** → D5: one writer per phase, and a phase is not complete until the other writer is deleted.
- **`CGO_ENABLED=0` versus macOS Keychain.** → D4: shell out to `security` with the secret on stdin, and keep the interface narrow so a cgo implementation can replace it without touching callers.
- **A headless core on a shared machine.** The core's control endpoint is per-user; a second OS user must not be able to drive it. → Reuse the existing per-user security descriptor on Windows and `0700` socket semantics on Unix, and prove it with a test that attempts access as another user.
- **Shell/core version skew.** → D3: explicit protocol version and a typed refusal instead of a degraded mode.
- **Scope.** The three TypeScript trees total ~16,900 LOC against ~4,600 LOC of Go today. → Phase by store and by capability (D5), each phase independently verifiable, rather than a big-bang port.

## Migration Plan

Phases are ordered so each ends with a runnable product and a single writer per store.

1. **P0 — freeze the contract.** Document the bootstrap record, the frame header, the method table, and the four parent-role methods; add a Go-side conformance test that drives a fake parent.
2. **P1 — core skeleton and shell proxy.** `dshkerd` starts, bootstraps, and serves a versioned echo of the existing p2p operations by delegating to the current TypeScript implementation through the shell. The shell is still the owner; this phase proves the channel.
3. **P2 — networking ownership moves.** Catalog, credentials (D4), pairing, and the connection state machine move into the core; the Electron writers are deleted in the same phase; the peer's parent-role methods are answered by the core (D7).
4. **P3 — DSH lifecycle moves.** Harness checkout management, `dsh web` start/stop, port preflight and residual adoption, the log stream, and process supervision (D6) move into the core.
5. **P4 — remote route moves.** The OpenSSH resolution, descriptor transfer, broker, and tunnel move into the core; `electron/main/remote` is deleted.
6. **P5 — headless entry point.** `dshkerd serve` and the named CLI operations ship, with packaging for macOS, Windows, and Linux, and packaging evidence for the new binary.
7. **P6 — shell becomes a shell.** Main keeps only window, `dsh-app://`, native dialogs, guest webview, tray, and updater, proxying named operations.

Rollback: through P4 the previous phase's artifact remains the releasable one, because each phase is a commit range that leaves the product runnable. From P5 on, rollback means reinstalling the previous release; no runtime fallback path is added at any phase.

## Open Questions

- Whether the headless Linux build ships as a service unit, a container image, or only a plain binary is a packaging decision for P5 and does not affect the specs, the ownership boundary, or the task breakdown.
