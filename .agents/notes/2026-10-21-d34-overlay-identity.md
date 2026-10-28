# D34 exact diagnostic build identity

D33 remains terminal FAIL. Its first physical case failed the unchanged initial-
transport barrier before fault injection (`test.initial_setup_failed`, Mac's
last-observed state unknown). Its socket JSONL used the legacy
`getsockopt_queue`/`queue` shape rather than D33's declared `queueProbe` schema.
Candidate/build inspection found that the D33 gate checked ambient `GOFLAGS`
for only a `-overlay=` substring and checked module versions, not the exact
overlay path or compiled schema. This makes its intended queue observation
invalid; it does not explain the actual ICE establishment failure.

D34 uses a fresh ignored directory and separate marker, environment names,
overlay virtual paths, `d34-ice-<nonce>.jsonl` files and candidate output. Its
local identity gate binds the overlay/test-overlay hashes, exact app source and
`go.mod`, helper/test files, the explicit absolute `-overlay` build flag, binary
schema markers and `go version -m` Pion modules. A mismatch must stop before
physical capture/SSH. D33 and D32 evidence remain immutable.

D34 remains diagnostic-only. The physical runner still requires an independent
review and a fresh pure-test receipt before one physical run. Even a valid D34
queue observation cannot establish an OS privacy/netpoll root cause by itself,
and does not pass production, UDP-loss, eight-hour or native-app acceptance.

Local D34 evidence (2026-10-21): the exact overlay/test-map and Windows
environment checks pass 25/25 Node cases. A separate, single local active two-Pion UDP peer run produced two
complete socket logs with 34 and 17 queue samples, zero invalid samples, zero
drops and joined samplers. The first shorter direct-DTLS/data-channel preflight
is preserved as incomplete because it closed before the one-second sampler
interval; it is not counted as queue-sampling evidence. Isolated Darwin arm64,
Windows amd64 core and Windows integration-test binaries all passed the D34
overlay marker, schema and pinned Pion module identity checks. These are local
diagnostic build/preflight results only. No D34 Mac capture/Windows SSH physical
run occurred, no ICE root cause is established, and the independent review,
production test matrix, eight-hour gate and release remain open.

The D33 raw first-case trace further narrows the failed phase: accepted offer
and applied answer plus a successful lease renewal were observed, but both
candidate PeerConnections remained in ICE `checking` for roughly 30 seconds,
with `selectedPath: null`. Mac's matching sockets recorded no queued datagrams;
Windows does not expose the probed queue fields. Since D33 did not preserve a
simultaneous physical packet capture, this cannot distinguish outbound loss,
inbound loss, or receive-loop delivery. Do not call this an ICE root cause.

The D34 helper's exact child-process environment now has a pure fixture check:
it removes inherited process variables, sets only the declared allowlist on
that child, constructs PATH from System32/SystemRoot/the pinned Node directory,
and emits a readback audit before launching the candidate. It does not alter
machine/user environment, use a different Windows account, or imply OS
isolation. Runner generation and syntax checks pass; no physical D34 runner is
active. The Mac D34 capture is not currently running, so no physical diagnostic
has started.

Local non-release baselines also pass: server `go test -race ./...`, `go vet`,
standalone dependency-boundary check, and Linux amd64/arm64 builds; Launcher
environment/format/architecture/type checks, all 1,893 tests, service/visual
smokes, renderer/Electron builds, and desktop app-integrity validation. These
verify the existing v0.1.91 source only, not a new ICE fix or physical acceptance.

Raw receipts: `.run/d34-ice-socket-operator-20261021/pure-tests-20261020203500491-31848.json`, `.run/d34-ice-socket-local-peer-20261021-1792528205282-29174/summary.json`, and `.run/d34-ice-socket-build-20261021-local-01/d34-compiled-overlay-identities.json`. The earlier data-channel run with no queue samples remains at `.run/d34-ice-socket-local-peer-20261021/summary.json` and is not overwritten.
