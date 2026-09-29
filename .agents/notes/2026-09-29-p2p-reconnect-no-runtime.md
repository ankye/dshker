# P2P reconnect does not start local DSH

## Decision

Automatic catalog reconciliation is a transport-maintenance action only. It sends
`requestWorkbench: false`, and the peer handshake keeps the direct connection
without invoking the local DSH runtime owner. An explicit remote-workbench connect
sends `requestWorkbench: true` and may start the peer's DSH runtime.

## Implementation

- Added the additive `workbench.request` peer capability.
- Added the strict shell/core `requestWorkbench` field to `peer.connect` payloads.
- Added `connected` as the transport-only state; `ready` remains workbench-ready.
- Kept the core autoconnect engine's live-stage handling aware of `connected`.

## Validation

- The full local release-readiness run passed: 166 Vitest files / 1,485 tests,
  four foundation E2E files / six tests, static checks, performance budgets,
  macOS arm64 packaging, headless core smoke, all six `dshkerd` distributions,
  metadata verification, and packaged-app smoke. Local packaging explicitly
  disabled certificate auto-discovery to match the repository's unsigned
  release policy; GitHub Actions remains the source of published installers.
- `go vet ./...` and `go test ./internal/... ./cmd/...` passed.
- The real coordinator/Harness integration suite ran with both required local
  artifacts. All network soak, recovery, direct-transfer, lease-expiry,
  revocation, CLI, and real-DSH cases passed except one stale assertion that
  expected `connected` despite receiving a valid workbench (`ready`, generation
  1). After correcting that assertion, `TestCoreDaemonCompletesAPeerConnection`
  passed independently, including the authenticated probe through the direct
  UDP path. The full integration package was not rerun after this test-only
  correction.
