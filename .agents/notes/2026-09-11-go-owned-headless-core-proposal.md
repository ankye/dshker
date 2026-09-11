# Go-owned headless core — proposal recorded

`openspec/changes/go-owned-headless-core/` now holds the plan for moving networking,
the reverse proxy, credential storage, and the DSH lifecycle out of the Electron main
process into a Go core (`dshkerd`) that can run with no desktop session. `openspec
validate go-owned-headless-core --strict` passes and all four artifacts are complete.

## Why the shape is what it is

The seam already existed, which is why this is a move rather than a rewrite: the Go
helper already owns the coordinator client, the ICE/DTLS peer session, the reverse proxy
(`runtimebridge`, an `httputil` reverse proxy over the bound runtime), the remote
directory listing, and a private RPC channel bootstrapped by one JSON record on the
child's stdin (`localrpc.AcceptMain`). What lives in TypeScript is orchestration:
`electron/main/p2p` (27 files / 5,768 LOC), `electron/main/remote` (6 / 1,447) and
`electron/main/managed` (43 / 9,689) against 31 Go files / 4,621 LOC today.

## Decisions worth remembering

- **`dshker-peer` stays a child process** of the core rather than being linked in. It
  parses attacker-controlled network input, so keeping it out of the process that holds
  decrypted credentials and the DSH child preserves defence in depth and reuses a contract
  that is already implemented and tested.
- **Electron starts `dshkerd` and proxies over the private local channel.** This
  answers the question directly: a local WebSocket the renderer connects to would add a
  loopback control surface, duplicate admission and projection in the renderer, and widen
  what a compromised renderer can reach. The bootstrap-plus-private-socket pattern keeps
  the core off the network entirely and lets the same binary serve a headless run.
- **Credentials move to OS providers in Go** (DPAPI, Keychain, Secret Service) with no
  plaintext path and an explicit failure when none is available. macOS is constrained by
  the helper's existing `CGO_ENABLED=0` build, so the Keychain is reached through the
  system `security` tool with the secret on stdin, behind an interface a cgo shim can
  replace later.
- **One writer per store per phase.** The root registry, device catalog, credential
  records, and launch preferences each switch owner in a phase that also deletes the old
  writer. No dual write, no runtime fallback.

## One thing that is easy to miss

Three active changes still contain requirements that this move contradicts, and none has
archived, so the main `openspec/specs/` tree is empty and a MODIFIED delta in this change
has nothing to resolve against. `managed-remote-dsh-connections` is explicit: "Electron
main SHALL own OpenSSH and file-transfer resolution, subprocess arguments, temporary
files, peer secrets, DSH session credentials, HTTP peer calls, persistence, and process
shutdown". `direct-peer-dsh-sessions`, `harness-runtime-supervision`,
`desktop-renderer-authority`, `managed-harness-roots` and
`desktop-launcher-release-readiness` say the same in their own words. Design D8 and task
7.3 record that each of those changes must amend its own delta before it archives, and
neither this change nor task 7.3 edits another change's delta.
