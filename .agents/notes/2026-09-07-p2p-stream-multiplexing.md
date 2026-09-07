# P2P stream multiplexing and DSH API audit

User authorized continuing the complete remote workbench implementation. Applied the active OpenSpec with quality-engineering diagnostic checks; did not publish or mark broad platform tasks complete.

## Changes

- Added production per-direction credit accounting and an authenticated-link stream multiplexer with explicit attempt/runtime-generation scope, monotonically partitioned stream identities, fixed 128 KiB receive rings, 64-stream admission, cancellable writes, FIN and stream-local RESET.
- Tests cover credit exhaustion/exact resumption, invalid credit without mutation, draining FIN/reverse traffic, ring-wrap byte equality, stream budget, independent RESET, cancelled writers, stale scope and unknown/duplicate stream admission. Uses real Pion transport with existing test-only identity/STUN composition, not full server/helper/UI acceptance.
- Updated the diagnostic test manifest with production field bindings; it deliberately still fails full-worktree verify for incomplete/undeclared desktop scope. No acceptance claim from focused test success.
- Audited the actually selected DSH commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`, distinct from the reference checkout HEAD. Source findings are in `docs/testing/remote-workbench-api-audit.md`.

## Remaining design dependency

DSH's server can create/register workspaces and sessions, but the selected browser session is client-owned. No supported external targeted navigation/readback entry was found in the audited client/session/workspace composition. `session.openWorkspacePath` opens the remote OS file manager, not a DSH session. Native directory picking also remains on the host desktop.

The complete workbench needs an explicit, versioned Harness client extension/navigation contract and ownership agreement. OpenSpec requires resolving this instead of injecting scripts or mutating private stores. No Harness files, active version pointers, user data or installed app were changed. Task 1.4 still needs runtime readback; 3.4 still needs full pressure/platform evidence; 4.7/5.10 cannot be called complete.

## Validation scope

- Diagnostic commands: `go test -race -count=10 ./internal/peer ./internal/protocol` (initial mux tests); `go test -race -count=3 ./internal/peer ./internal/protocol` (admission cases), followed by a final fresh focused run and `go vet`.
- Full source-size check, OpenSpec strict validation and default test-integrity verify are run at handoff. The integrity check remains a release blocker until the whole desktop change has an implementation-complete manifest and actual runtime artifacts.
- No full desktop suite, packaged DSH workbench, one-hour soak, physical Windows validation, commit, push or release is claimed.
