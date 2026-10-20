# Agent Note: distinguish transport loss from workbench refusal

## Evidence

The user challenged an over-broad report that P2P was failing. Read-only CI
classification and actual local coordinator/peer processes established that
basic bidirectional P2P and reverse-direction reconnect work. The exact
connection failure was in the candidate workbench admission boundary, not a
general inability to establish ICE.

- Client Quality run `39376523526`: optional-workbench cases failed after a
  real transport became ready. `runCandidate` discarded the typed refusal from
  `runtimebridge.Establish`, then `probeCandidate` treated its deliberately
  absent gateway as a failed device connection.
- Other failures independently used stale test inputs: method table 1 instead
  of 2 (wire frame remains 1), no confirmed-login `/v1/user` endpoint, missing
  explicit catalog registration, and a SQL pair-row ID instead of DeviceID.
  A real-Harness case also had the wrong suffix for CI's explicit exclusion.
  These are corrected assertions/setup, not permission to skip a failure.
- Package run `39376523547`, Windows ARM64: trace reached first-frame capture,
  then exited 0 without a result payload. The sole window's destruction
  triggered normal `window-all-closed` quit before evidence was written. The
  summary's false renderer fields reflected absent evidence, not observed
  renderer errors. Raw traces remain under
  `.run/peer-ci-package-39376523547/`.

## Repair boundaries

- Preserve an explicit optional-workbench refusal on the exact session before
  Ready can race with a committed control event. Commit connected transport,
  zero runtime generation, empty entry and exact refusal, never false ready.
- Restore that refusal after suspension. Keep existing workbench intent and
  retry classification; do not extend deadlines, substitute another runtime,
  restart DSH or broaden predecessor-health rules.
- Reject unsolicited/incomplete bindings and unexplained missing bindings.
  A provided workbench still requires authenticated HTTP and WebSocket probes.
- Detach only the predecessor mux. An initiated browser listener remains open
  at the same URL for a later verified binding. An answered ServeTarget endpoint
  still closes normally; its test fixture now uses the correct direction.
- In explicit smoke mode only, let the awaited smoke dispatch own app exit.
  Success/failure evidence finishes before exit. Diagnostic write errors are
  reported to stderr and still exit 1; ordinary close/tray behavior is unchanged.

## Validation tiers

- Real local coordinator/two peer processes: both directions live together
  across lease expiry, plus reconnect preserving the reverse direction, passed
  under the race detector. See
  `.run/p2p-ci-recheck-20261020/direct-bidirectional-current.log` and final
  reverse-only readback in `direct-reverse-final.log`.
- Focused D26 race tests: 24 top-level / 69 including subtests passed; signed
  consecutive candidate scopes, real Pion, negotiation and HTTP/WS prove
  ready → explicit refusal → ready through the same live browser URL. These
  are local protocol oracles, not real Harness or physical-machine acceptance.
  Raw `.run/open-workbench-recovery/candidate-workbench-browser-race.jsonl`.
- Complete peersession/runtimebridge/autoconnect race suites passed; raw
  `.run/p2p-ci-recheck-20261020/optional-workbench-final-race.log`.
- Full desktop unit suite passed all 1,891 tests on the final implementation;
  environment, architecture, type, service and visual source checks passed.
  Integration compile-only admission and `go vet ./...` passed; neither is
  relabeled as execution of the credential-writing integration cases.
- Smoke lifecycle red/green checks retain success, render refusal, payload
  write failure and trace failure, with ordinary Windows/Linux/Mac/tray behavior.
  Related smoke tests passed 20 cases; actual ARM64 package still needs CI.
- Native credential-writing core/CLI integration is deferred to the isolated
  CI credential provider. A temporary data root does not isolate shared Mac
  Keychain; no installed app, credentials or original runtime were changed.
- Independent review closed the unrequested-binding admission gap, corrected
  false browser-direction coverage, and required failure exit when diagnostics
  cannot be written. No remaining issues were reported in that final scope.
- Historical failed physical program-pause/stress evidence and incomplete
  eight-hour evidence remain failed/incomplete, not replaced by local passes.
  Final-SHA CI, package smoke and installed UI remain separate pending gates.

## Server provenance correction

The production service was inspected read-only. Its live executable and installed
binary share SHA-256
`4d5b9532f98f50eb986f9100044d4d302ea2dc23242a64b5e978a7736abe8a5c`.
That matches the frozen D20 Linux artifact. All 37 runtime Go/module build
inputs match the frozen manifest and current server HEAD `f346959`; later
changes are documentation/CI, not runtime. The VCS `424e195+dirty` label dates
the build, but does not make these current source contents outdated. Health
and TCP/UDP 8443 were verified; no deployment, restart or data change was needed.
