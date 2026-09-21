# SSH connection form and compact account header

## Scope

The remote route now presents the first sub-tab as **SSH 连接 / SSH connections**. The managed-computer list always exposes an Add computer action; the existing row actions remain the place to test, connect, open a workbench, edit, or remove a saved computer.

The add and edit forms accept an optional absolute local `sshKeyPath`. The path is validated at the renderer admission boundary and again by the Go core. It is persisted as catalog metadata when present and passed as an argument value to both SCP descriptor transfer and SSH loopback forwards. The private-key file is never read by the renderer, sent over the peer channel, or copied to the remote computer. An empty path is explicit OpenSSH configuration/agent mode, not an inferred secret.

Legacy catalog entries without `sshKeyPath` remain readable and project as an empty path. New catalog entries omit the empty field on disk and retain the existing five-field configuration revision; a non-empty key path participates in the revision so edits cannot silently race.

The Network & account card header is a two-row identity block: title plus account actions on row one, signed-in account on row two. This keeps the account identity and its controls together without changing the network/device authority below it.

## Evidence

- `npm run type-check`
- `npm test -- --run electron/main/remote-ipc.test.ts electron/main/remote/service.test.ts src/app/shell/tests/RemoteConnectionsPanel.test.ts src/app/shell/tests/RemoteConnectionsTabs.test.ts src/app/shell/tests/P2PAccountPanel.test.ts`
- `go test ./internal/remoteroute ./internal/remoteconnections ./internal/core` from `networking/`
