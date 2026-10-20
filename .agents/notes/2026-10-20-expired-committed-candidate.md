# Expired committed target retirement

Scope: `networking/internal/peersession/candidate_decision.go` and its ordered
candidate tests. Owning change: `repair-open-workbench-reconnection`, D13.

A target's authenticated committed event could wait until its signed lease
snapshot expired. Fresh-time lease admission ran before dead-carrier retirement,
so the event left its dead candidate in the one inbound slot and discarded the
immediately following prepared successor. Historical committed authority must
still retire that exact dead carrier and its named predecessor; it must not
authorize a live promotion.

The fix verifies the complete immutable receipt first, retains exact current
subscription, fence, core, account, active attempt, readiness and slot checks,
then retires the dead carrier before checking time permission for live promotion.
Retirement retains the stable predecessor gateway and exact `End(failed)` ticket;
it does not revoke the successor's scope. A live candidate still requires a fresh
lease before promotion and transport lease update.

The new expired-dead receipt regression failed before the production correction.
It shares the real Pion successor, exact end request, stable gateway and joined
shutdown assertions with the existing dead-carrier test. A separate expired-live
receipt case checks that promotion and lease mutation remain refused.

The earlier complete internal/cmd race result remains failed and preserved at
`.run/open-workbench-recovery/final-client-go-20261020/`. Its single real transport
failure lacks phase timing, so it does not establish a DTLS root cause. The
ordered test's former single three-second context included source SDP gathering,
an artificial target TURN gate, target SDP gathering and transport readiness.
The fixture now releases the already admitted successor's TURN gate before
source gathering and starts its three-second ready budget after accepting the
exact signed answer. Its five-second parent resource lifetime and all production
ICE, grace and establishment deadlines remain unchanged. Phase timing and parent
deadline diagnostics remain in the test output.

Focused red/final race logs, vet, line counts and new production source identity
are recorded separately under
`.run/open-workbench-recovery/expired-client-repair-20261020/`. These are local,
nonphysical checks and do not replace physical program-pause, native UI or
long-duration acceptance. No credential store, installed process or system
network policy was accessed or modified by this repair lane.

Final local verification:

- `GOFLAGS=-mod=readonly go test -json -race -count=1
./internal/peersession ./internal/peer ./internal/protocol`: 243 test/subtest
  passes, zero failures/skips/race reports across three packages.
- `GOFLAGS=-mod=readonly go vet ./internal/peersession ./internal/peer
./internal/protocol`: passed.
- Modified Go files contain 436 and 420 physical lines; formatting and the
  1000-line gate passed.
- The 157-file internal/cmd production SHA-256 list stayed unchanged during this
  final verification. Its list identity is
  `444ba294eeb484b891b4d6c44b1a303eafbef369869dc2b4490937b5e3e3feb8`.
  Relative to the earlier failed full internal/cmd run, only
  `candidate_decision.go` changed production identity. The earlier full-suite
  failure remains historical evidence; this focused pass is not a replacement
  for final full-suite or physical acceptance.
