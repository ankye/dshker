## Why

DSHKer can only reach a remote DSH while a **GUI Electron process runs on that machine**. The Electron main process owns secret storage, process supervision, the Harness checkout, the P2P session, and the SSH descriptor/broker path, and the P2P helper refuses to run outside a parent (`localrpc.AcceptMain` needs a one-shot stdin bootstrap, then serves only a private per-user socket). A headless Linux/Windows/macOS box — a server, a CI runner, a devcontainer — therefore cannot be a peer or a host at all, even though the transport, the reverse proxy, and the remote directory listing are already implemented in Go.

The desired outcome: one Go native core owns networking, the reverse proxy, credential storage, and the DSH lifecycle; it runs headless from a command line; Electron becomes a shell over it. Target user: the operator of a headless machine who wants that machine reachable, and the existing desktop user who must see no regression.

## What Changes

- **New `dshkerd` native core (Go)** owning: the coordinator session and P2P transport (already Go), pairing/catalog/credentials, the SSH descriptor and broker, the Harness checkout lifecycle, the `dsh web` child, ports, and logs.
- **Ownership moves out of the Electron main process** — the Typecript modules `electron/main/p2p` (27 files / 5,768 LOC), `electron/main/remote` (6 / 1,447) and `electron/main/managed` (43 / 9,689) are retired or reduced to a thin typed proxy.
- **BREAKING (internal contract)**: "the main process owns Git, filesystem, native dialog, subprocess, and secret-storage access" no longer holds. The native core owns subprocess and secret storage; Electron main owns only shell concerns (window, `dsh-app://`, native dialogs, guest webview, tray, updater) and proxies renderer intent.
- **Credentials move to OS-native stores in Go**: macOS Keychain, Windows DPAPI, Linux Secret Service. No plaintext fallback; an unavailable provider fails explicitly.
- **Electron starts `dshkerd` and talks to it over IPC** using the pattern the helper already uses: a one-shot bootstrap written to the child's stdin, then JSON-RPC frames over a private local socket (Unix socket / Windows named pipe with a per-user security descriptor). The renderer keeps its frozen typed preload surface and never receives the core socket.
- **Headless CLI**: `dshkerd serve` plus named operations (`status`, `pair`, `connect`, `dsh start|stop`, `proxy`) so a machine with no desktop can be operated entirely from a shell.
- **Preserved invariants**: no relay; DSH Web stays loopback-bound and is reached through the same SSH/peer path; managed roots stay separately registered; the renderer still receives no filesystem, shell, or subprocess capability.

## Explicit non-goals

- No relay, TURN, or third-party transit; `direct_unavailable` stays a legitimate outcome.
- No change to the coordinator HTTP/WSS protocol or the helper's wire protocol.
- No new remote-access mode beyond the existing P2P and SSH routes.
- No DeepSeek Harness change: the core invokes the same `dsh` CLI with the same `--profile web` (and `pnpm dsh -- web --no-open [--port]`) and adds no Harness-side requirement.

## Capabilities

### New Capabilities
- `native-core-daemon`: the Go core's ownership boundary, its IPC contract with Electron, headless/CLI operation, native credential storage, and the failure behavior of each.

### Modified Capabilities
None at this stage. The main spec tree (`openspec/specs/`) is still empty: every capability that this change re-owns — `direct-peer-dsh-sessions`, `managed-remote-dsh-connections`, `harness-runtime-supervision`, `managed-harness-roots`, `desktop-renderer-authority`, `desktop-launcher-release-readiness` — currently exists only as an unarchived delta inside another active change, so a MODIFIED delta has no main-spec requirement to resolve against yet.

The changed behavior is therefore stated as ADDED requirements in `native-core-daemon` (ownership moves to the core), and `design.md` records the exact reconciliation: each of the three in-flight changes must amend its own delta to the new ownership before it archives, because those deltas still say "Electron main SHALL own … subprocess, and secret-storage access".

## Impact

- **Code**: `electron/main/p2p`, `electron/main/remote`, `electron/main/managed` (owner moves); `networking/` grows into the core; `electron/preload.ts` and `src/shared/contracts.ts` keep their names but gain a core-process layer behind them.
- **Build and packaging**: a new Go entry point plus its per-platform build, manifest, and packaging steps; the existing peer helper becomes a library or an internal mode of `dshkerd`.
- **Security**: two trust boundaries instead of one — renderer↔Electron (unchanged) and Electron↔core (new, bootstrap secret + private socket). Credential storage moves to OS providers; no plaintext or in-repo key material is permitted.
- **Platforms**: macOS, Windows, and Linux for the core; the Electron shell stays macOS/Windows as today.
- **Migration**: phased, with the existing OpenSpec changes (`add-self-hosted-p2p-dsh-connections`, `add-managed-remote-dsh-connections`, `add-managed-harness-desktop-shell`) reconciled by their spec deltas rather than duplicated.
