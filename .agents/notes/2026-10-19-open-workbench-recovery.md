# Open workbench recovery after overnight disconnect

## Current verification snapshot — 2026-10-20

D18 now implements the approved retained-network/explicit-first-choice contract.
Independent review also closed exact retiring ownership, atomic catalog changes,
stale empty-discovery lineage and exact Engine reauthorization/epoch fencing.
The cold committed/Prepared ordering defect reproduced deterministically before
repair. An additional signed-but-expired committed snapshot could block dead
retirement; its new red regression is preserved before the minimal correction.
Live promotion still requires a fresh lease. The fixture's previously combined
3s setup/ready budget was separated without extending its existing 5s parent or
any production timeout; the historical timeout cannot be attributed to DTLS.

The pre-D20 production Go identity for 157 internal/cmd files was
`444ba294eeb484b891b4d6c44b1a303eafbef369869dc2b4490937b5e3e3feb8`.
One full post-fix race run passed all 20 packages: 1135 pass events including
subtests, zero fail/skip/DATA RACE; vet and the source-size gate passed. The old
full-race failure remains in `final-client-go-20261020/`; the successful fresh
evidence is `final-client-go-20261020-fixed/`. Root verified the exact generated
stress marker contents before removing only its 18 Keychain items after each
complete run. No original device or account credential was changed.

The single fixed real Gin/two-Host/two-DSH cold run passed in 9.459s, with both
directions ready around 3.7s under the original common 25s deadline. The complete
required Manager/real-DSH integration command also passed (208.183s, eight top-level
cases and two subtests). Both raw logs are retained. Matching-core Vitest passed
1838/1838 with zero skipped tests; type/environment/architecture/service/visual
smokes, renderer/Electron source builds, format and outer-workspace validation
passed. These are source/local-runtime tiers, not native UI or long-duration proof.

D19's actual native cleanup preflight FAILED: its first two independent cases
failed in 52.36s and 86.64s, before a paused acknowledgement. The observer currently
conflates a failed debug-state query with true debug attachment, and the preflight
omitted independent runtime-owner teardown. Both are being corrected; insufficient
query rights remain a hypothesis until a focused native diagnostic records the
Win32 result. Evidence is `d19-native-cleanup-20261020/`; its exact temporary
binaries were removed only after a zero-owned-process readback. Two owner-lock
cleanup failures remain failures, even though no matching executable survived
the final readback. Original installed Win/Mac process identities are unchanged.

The D19 controller and recovery clocks use shared boot-monotonic ticks; UTC sanity
checks may refuse a clock discontinuity but grant no additional lifetime. Native
preflight, three program-unresponsiveness profiles, fresh core-crash recovery,
eight-hour bidirectional original-session idle, ten automatic rounds and native
UI/CI release gates are still outstanding. No current physical runner is active;
the old heartbeat is paused. Server deployment is only at read-only preparation;
there has been no commit, push, tag or release.

Later deployment: the independent server was switched once at
2026-10-19T17:33:02Z–17:33:03Z after complete local gates. It is now schema 7,
PID 508957, running Linux SHA
`56899d023106cf479faeeaf3d2fc747d393d2f792898349ebc7b8913e09000ba`.
TCP/UDP 8443, service/config/TLS/identity bytes and all twelve original tables'
full canonical contents/columns/definitions are unchanged (metadata excludes
only the intentional version update). The seven-file stopped-state backup stays
on the server at `/var/backups/dshker-server/pre-schema7-20261020-202bc76593f3/`
under root 0700. Trusted direct-IP/hostname HTTPS succeeds; this is not v2/WSS or
application acceptance. No website, TURN/lopub, firewall or power policy changed.

The focused query-only Windows diagnostic passed: the same exact new core's
limited handle returns Win32 5, while QUERY_INFORMATION succeeds and reports no
debugger. It never attached or paused. Required query rights are now acquired
once in pause-only helpers with full original identity proof; shared process
helpers remain unchanged. Authenticated independent owner teardown is now
registered before startup/arm, including the orphan-runner handoff.

The next native cleanup attempt genuinely passed ControllerCrash (1.60s) but
failed ParentGone (1.21s): the live controller raced the guard, releasing early
with `test.pause_hold_interrupted`, and the guard admitted that failed normal
result. Both failed rounds remain retained. The correction makes the guard the
sole release owner on runner death and records actual exact-controller terminate
and join; strict parsing cannot relabel interrupted normal results as success.
Its pure/cross-compile/review evidence was not native acceptance. The subsequent
one-shot native preflight in `d19-native-cleanup-guard-owner-20261020/` passed
ControllerCrash (1.67s) and ParentGone (1.45s), with exact debugger ownership,
authenticated runtime-owner teardown, zero remaining owned processes and removed
temporary binaries. ParentGone proves the guard terminated and joined the exact
controller; ControllerCrash proves external controller termination. This is only
native cleanup safety: the normal 3s/35s/repeated profiles and online v2/two-Host
acceptance remain pending. All failed attempts remain unchanged.

The online test's independent review found missing joins for concurrent traffic
and an initial Reconcile that could block beyond the business deadline. A
test-only worker owner now cancels operations, closes these two Hosts (and thus
their independent Engine contexts), and joins every job before any remote scope
cleanup. A cleanup timeout remains a failure and forbids scope deletion. Pure
worker regressions pass; independent re-review and a single actual online run
remain required. No production timeout or source was altered for this test fix.

The first actual online run in `online-candidate-20261020/` failed in 4.34s with
unchanged full source digest `23d394285793f2689a95bf3292a36c64299d26cb1e609757327e3c1b2930d20e`.
System public TLS, real mTLS WSS101, scoped identity, candidate prepare/Ready/
commit/state/renew/end all passed. Both production Host transports connected
around 536/554ms, but concurrent directory.refresh failed with
`p2p.rate_limited`; no actual DSH HTTP/WS business pass is claimed. All Bearer
cleanup requests hit the same denial. A failed Networks result's zero length is
not empty-state proof. Root later verified the exact generated test account,
network, pair and two devices, disabled only that account through the official
CLI, and read back its session count 1→0 and revoked pair. Five unrelated table
projections stayed byte-identical; no service restart or original-user mutation
occurred. Test records remain disabled for evidence, and the original failure is
unchanged. See `owned-scope-retirement.json`.

D20/D6 now covers the confirmed shared-IP Bearer classification gap: explicit
matched account routes may use proven device TLS for resource accounting while
preserving real Bearer authorization and all existing limits. The client uses
explicit setup/device/closed transport ownership for ordinary management reads;
named authentication confirmation and original-key certificate recovery remain
public to avoid an expired-certificate dependency cycle. Separate real-TLS red
tests reproduce both the server's 20-success/4-denial same-NAT burst and the
client's missing device certificate. The server repair was subsequently deployed
at 2026-10-19T18:36:50Z–18:36:51Z, one stop/start, PID 527042, Linux SHA
`4d5b9532f98f50eb986f9100044d4d302ea2dc23242a64b5e978a7736abe8a5c`.
All twelve original user tables, fourteen schema definitions, all indexes and
five identity/config/unit files are unchanged. Existing production restart logic
cancelled exactly one pending attempt and removed exactly two expired active
pointers, all from the disabled failed-test scope; every other control row/column
was verified unchanged. The complete seven-file backup remains root-only at
`/var/backups/dshker-server/pre-d20-20261020-5896fa48c0fb`. Both trusted public
hostname and direct-IP HTTPS passed. See `server-deploy-d20-20261020/`; no current
client online/physical acceptance is implied. Client repairs remain in progress;
none of this proves the original overnight ICE cause or the physical gate.

## Approved joint client/server handoff follow-up

The user approved repairing the client and standalone server together, real local
integration first, then replacement of the existing production service preserving
8443, followed by bidirectional physical and long-duration tests and stable
publication only after required gates pass. Server ownership remains independent
Gin/SQLite, not NetHopper. The server plan is GoWorkspace OpenSpec change
`preserve-dshker-active-connection-on-recovery`; client D13/D14 record the joint
wire and lifecycle. The earlier no-server-change boundary below describes the
earlier diagnosis phase and is superseded only by this explicit later approval.

The final design uses current authenticated v2 registrations, explicit selected
account (empty means signed out), one primary and one candidate per directed link,
candidate-only authenticated HTTP/WS verification, and durable active/decision CAS.
Same-core resubscription changes the current fence, not immutable prepare identity.
Initial signed ticket bytes and creation epoch remain intact across readback.
Commit ambiguity enters resolving; neither request cancellation nor an old carrier
recovering proves server cancellation. No v1/relay/IPv4-only/runtime-start fallback
is permitted. Additive schema 7 preserves service keys, accounts and network records;
deployment has not happened merely because its plan is approved.

### Desktop live-state implementation and review

- `suspended` retains exact primary attempt/generation/runtime authority but never
  counts as ready or a currently live direct path. Its only UI privilege is keeping
  an already admitted guest in that open lifecycle; no fresh entry is issued.
- Open lifecycle admission is removed on close and catalog prune. A suspended
  close/reopen or remove/re-add cannot mount a new guest from the old entry.
  A subsequent ready state can read/admit the current entry normally.
- SSH list cleanup is restricted to SSH navigation so it cannot reset the deep
  P2P URL and reload its original WebSocket. The peer watcher retains exact-owned
  suspended navigation as well as its guest element.
- Main serializes peer.state authorization/admission per service/pair. Reversible
  ready/suspended transitions cannot be ordered by async catalog completion, and
  latest-arrival-wins is insufficient because it could discard a terminal state.
- The private shell/core method-and-state contract is version 2 on frame 1.
  Both parent-start and attach enforce it. It admits 32hex v2 attempts without
  widening 12hex device/network identity. Old cores are explicitly incompatible.

Independent review found and drove the navigation/open-lifecycle/async-state
corrections; deterministic tests cover deferred authorization, terminal barriers,
original guest DOM/deep URL, SSH refresh, revocation and suspended reopening.
These are source/component tests, not native guest/network acceptance.

Current diagnostic full-app run retained in
`joint-control-v2-ts-tests.json`: 1805 passed, 4 failed, no skips; the four real-core
cases read the old locally built table-version-1 binary and correctly failed the
new table-version-2 check. Do not remove the four tests, weaken version admission
or label that report passed. Rebuild an isolated matching test core after the Go
implementation is complete, then run the full suite again. Type and architecture
checks passed; source-size measured 171 changed code files with zero over limit
at that snapshot. Candidate Go/server implementation and full physical/release
verification remain in progress. All original installed processes are preserved.

### Current-account identity review and joint validation update

D15 preserves the original device owner and requires an explicit selected account
from the existing durable user session. Failed membership reads remain typed and
cannot substitute the enrollment owner. D16 adds scoped v2 identity and a two-phase
read-only-registration/fresh-pin/candidate-capability barrier. Review found that
legacy identity projected enrollment owner A even for selected account B; simply
strengthening Pin would reject every legitimate B connection. The explicit v2
read repairs that boundary without changing legacy DTOs, IDs, keys or certificates.
Raw `pairs.pin` is removed from the private core and approval caller; cached/null
restore pins are refused before activation. Pending identity remains readable but
never grants a live pin.

The isolated matching-table-2 core/full-app diagnostic now passes 1818 tests with
zero failures or skips (`joint-control-v2-ts-matched.json`), resolving the earlier
four old-binary contract failures without weakening checks. Before D16, real Gin
process + both Managers passed twenty reconnect rounds per role; real DSH runtime
replacement and network revocation also passed. Those snapshots are retained in
the `joint-control-v2-*-first.jsonl` reports; D16 changed source afterward and still
requires its own complete joint rerun. These do not prove native UI or long idle.
The outer desktop validator passes; source size measured 203 changed code files
with none over 1000 at that snapshot. Original Mac and Windows process IDs and
start times were re-read unchanged; no installation, network or provider change.

The obsolete `networking/tools/live-drive/main.go` driver is removed (recoverable
from Git). It had no current consumers, used old bootstrap/pin APIs and embedded
deployment/credential/runtime defaults. Historical audit results are not erased;
the verification-boundary document names its removal and the current diagnostics'
actual Mac Engine/Manager versus full serve/native UI tier.

The standalone server's final full race/vet/boundary/public dependency/build/symbol/
process smoke gates pass with presence and D16 included. Its frozen source digest
is `110bec1afc60ff3d22692a7a9c411bca789431944a79f54487e5381f4f36f2d6`;
Darwin test artifact SHA256 is
`8a95a9dc34cacd73fe7c476c56f3e23edcc4b4d9b86ed8405959e250102b73e9`.
The independent reviewer approved that source slice, not physical acceptance.
Local joint reruns are in progress; deployment and publication have not happened.
New D16 real-process runs are retained failed: the selected-account test initially
compared the Enroll response UserID to the static owner (the existing response
correctly names token account B); it now separately checks signed canonical owner
A and unchanged ID/key/certificate. Full joint bootstrap also genuinely hit
`p2p.rate_limited`: two complete restores cost 26 requests before extra directory
and candidate traffic. D17 records independently reviewed unchanged-limit TLS
principal budgets plus exact candidate/cleanup/bootstrap transient ownership.
Its implementation and new complete gates are in progress; old server hashes
above are no longer the final release candidate. These failures are not waived by
fixture sleeping or longer recovery deadlines. The user subsequently approved
D18: retain the existing freshly authorized network; ambiguous first connections
require an explicit choice. Implementation and verification remain open.

The physical runner is also updated, not yet run: both roles use production
auto-connect policy, its ten bidirectional rounds follow the full original idle,
and per-fault time starts before injection. Initial test-config v2 carries the
real issued session into Windows setup; no post-crash injection is permitted.
Pure session/lifetime/Mac-owner tests and eight Node identity/proof tests pass;
these validate the observer contract, not physical recovery. Explicit tracked
deletions now contribute correctly to the working-tree source identity without
depending on staging. No old evidence directory is overwritten.

The firewall-disabled UDP gate remains failed. The user subsequently approved
D19 program pause/resume (3s, 35s, repeated pulses) plus core crash/restart in its
place, without enabling the firewall or changing system networking. This measures
program unresponsiveness, not UDP loss; the eight-hour gate is unchanged.

### D17 frozen server and current local rerun

The server's D17 full gate passed with 197 pass events, zero failures/skips/races,
vet, boundary/public dependency checks, three platform builds and a real HTTPS
process/persistence smoke. Current server source digest is
`202bc76593f322aad8351269043767d6501a3f6c0141851c3ddf54d40c80baf1`;
Darwin test artifact SHA256 is
`5e6095bb231a5228d00349d4f25d92e26d0dab404904949c4a7922ff68e9ef29`.
The earlier server digest above remains historical, not the deployment candidate.
The server worker did not deploy or commit. The real workspace vendor mismatch
is still reported; verified commands use explicit scoped `-mod=readonly`, not a
different workspace or disabled workspace.

Client D17 production Go is frozen for local joint rerun after complete relevant
package race checks. Transient bootstrap retains one service owner and the exact
durable session/device fingerprint; End cleanup keeps its exact ticket after
local finish and joins on shutdown. A successful Ready response without own-ready
evidence is still resolving, not permission to promote. See the separate Go Agent
Note for actual test names. Root has started new real Gin/Manager/DSH integration
and complete internal/CLI race runs under `joint-control-v2-d17-*.jsonl`; until
they finish their launch is not a pass. Independent review remains in progress.

The independent runner review found two test-only false-negative/false-positive
risks and root repaired both before any new physical run: `/diagnostic` now admits
nonempty 32hex candidate attempts rather than legacy 12hex device IDs, and the
browser captures its original cookie after initial real authentication. Every
later HTTP/RPC/WS authentication or detached request verifies that exact original
cookie before and after; a shared cookie jar is not identity preservation. Pure
regressions cover rejected legacy/foreign diagnostic scope and successful HTTP
with a same-jar replacement cookie. These strengthen proof only and do not replace
the outstanding physical run, D18 implementation, D19 replacement or native UI gate.

### D18 explicit choice and D19 approved program profile

The add-tab popover now selects an ambiguous computer's network in place, with
no preselection, duplicated computer/tab or nested dialog. A stale saved network
is retained as stale even when complete discovery returns no choices. Selection
is actor/revision scoped; stale replacements use one atomic catalog transition
publication. Back, close, account/service changes and unmount invalidate pending
page-open intent. Unknown write outcomes allow fresh readback, not replay.

Source/component, IPC and type checks passed for this UI slice. Real Chromium
test-entry verification passed 48 combinations (six states, four viewport sizes,
light/dark) with no JavaScript or measured overflow errors; keyboard focus,
Escape return, disabled unknown/pending operations and reduced motion were
checked. Root inspected the narrow long-name screenshot. Evidence is
`.run/open-workbench-recovery/network-choice-browser-matrix.json`. This is an
isolated renderer fixture, not native Electron, core, physical or latency-ledger
acceptance. The own Vite server was stopped after the checks.

The fresh real Gin/two-Host cold-bootstrap run
`host-cold-bootstrap-owned-retry.jsonl` failed and remains retained. Both original
production retry jobs restored transport without repeated Restore calls, but one
workbench candidate stayed PC/ICE=new with no answered event until its unchanged
25s deadline. Investigation identified a committed/prepared ordering race at the
target candidate slot; the minimal production correction and deterministic
regression are in progress. This is not a pass and will not be rerun unchanged.

D19's Windows debugger-based pause controller and independent cleanup guard are
test-only work in progress. Pure checks and cross-compilation do not establish
native pause or recovery behavior. No new physical runner, deployment, commit,
tag or release has occurred.

## Follow-up: independent runtime authority repair

After the retained process-crash failure, the user authorized repair, verification
and a stable Release only if verification succeeds. OpenSpec D12 adds a private
runtime-owner process rather than PID/URL record adoption. It retains the actual
Supervisor, child handles, output pipes, binding generation and console cursor.
The replaceable networking core connects to that authority in both production
entry points. A disconnect is not Shutdown; an explicitly normal shutdown still
stops and joins the authority. An unsuccessful core boot only drops its client
connection and cannot stop a previously recovered runtime.
It cleans up its own freshly created empty authority instead of leaving it behind.

The private mode dispatches before any credential/provider access. It uses the
exact configured roots, a private OS lock, authenticated local transport and a
versioned identity bound to the executable and DSH home context. Corrupt, missing,
incompatible or unreachable owners fail explicitly; neither a second owner nor
a local Supervisor is a recovery substitute. A stopped DSH is never cold-started
by resume. Fixed-port admission is read-only and cannot kill a regex-matched
process. Existing orphan launches from the old model are not safely adoptable.

Implementation and verification are in progress. This section is not an
acceptance claim. Preserve the failed original core-crash scenario, incomplete
eight-hour run, unenforced UDP profile, initial ICE failures and missing UI or
release evidence. The private process architecture does not explain the original
overnight ICE loss. Installed clients and their original processes remain out of
scope; no firewall, coordinator, shared Keychain or system networking change is
authorized for these tests.

### Runtime-owner verification so far (not release acceptance)

- The complete application suite passed 1778 tests after the local owner-error
  admission repair. Source type/architecture checks and renderer/Electron builds
  passed; these are not installer or native UI acceptance.
- The full Go internal/core CLI race invocation passed 992 tests across twenty
  packages without skips. Its existing macOS secret-store tests exercised only
  test keys, not device credential records. The legacy stress test left nine
  known test markers; an ignored guarded cleanup read only those exact markers,
  verified every expected test value, then removed those nine test keys. No
  device credential key was read or changed by this cleanup. The test markers
  are disposable and were not backed up.
- The real no-data-root parent-driven core private-channel lifecycle passed on
  macOS without opening a credential provider. Separate runtime-owner process
  tests preserve actual child/output/binding identity; they are not real DSH or
  physical P2P proof.
- First Windows native owner execution found the directory-visible-before-ACL
  race: four concurrent opens were refused. Atomic CreateDirectoryW with the
  final protected same-user DACL fixed that boundary. The second full owner
  suite passed, but a subsequent twenty-round native concurrency run failed
  twice with fifteen-second owner startup refusal. Both failed runs are retained;
  a single green suite does not approve this candidate.
- The third candidate added a delete-sharing record reader. Twenty concurrent
  startup rounds passed, but the deterministic held-reader publication case
  failed in all twenty rounds. A diagnostic-only fourth candidate reproduced it
  once at `record rename errno=5` (Windows access denied). Its retained output
  distinguishes the actual failed rename from an inferred startup timeout.
  The Windows publication API is being corrected; no retry, timeout extension,
  broad ACL or replacement owner is an acceptable substitute.
- The fifth candidate uses FileRenameInfoEx with replacement and POSIX semantics
  as its only Windows publication operation. Independent source review found no
  remaining API/ABI or HANDLE security defect. The complete native owner suite
  passed, then all twenty fresh-open concurrency rounds, twenty atomic-DACL
  rounds and twenty deterministic held-reader publication rounds passed. The
  earlier failures remain retained. Candidate SHA256 is
  `61ee314c8f7e5ece233ee59d46602549abaca95956f8674234ec0f9d406be6ee`;
  raw evidence is `windows-owner-v5.log` and
  `windows-owner-concurrency-v5-native-20.log`.
- First Windows localrpc execution lacked the source-relative dispatch inputs.
  Supplying a hashed archive of the actual helper/peer/core source made the full
  native suite pass, without excluding its method-table test. Both outputs are
  retained under `runtime-owner-20261019/`.
- The local six-code IPC defect is fixed: actual typed core owner failures stay
  distinct through start/stop/status results in both Launcher and installation
  operations, with fixed non-secret messages and locale guidance. Independent
  focused review passed. The prior source report's Node-test/Vitest discovery
  conflict was fixed by using explicit `*.node_test.mjs` suites; all five native
  Node tests remain mandatory commands, not omitted tests.

The candidate package metadata is 0.1.91, still unpublished. Windows owner
publication has passed its native regression gate. Preparation also found an early-fatal
integration teardown gap: the authenticated independent owner must have a sealed
cleanup immediately after serve readiness, before any runtime start or remote
open can fail. That test-harness repair now passes twenty race rounds and Windows
compilation; its independent review is separate from actual physical validation.
The mandatory manager integration command remains failed: four cases passed,
but `TestManagersAlternateOfflineAndRecover` failed in 22.27 seconds. Its raw
`manager-integration.jsonl` is preserved and is under investigation, not retried
unchanged or waived. The five explicit Node tests and formatting check passed.
The retained manager failure is a real new diagnostics race, not an offline
cycle assertion failure: all eight offline/online cycles completed, but the
one-second sampler called the pinned Pion ICE selected-pair stats getter while
StartContext wrote its gatherer. The race report identifies the concurrent read
and write stacks. A minimum concurrency repair with a deterministic regression
is required; removing diagnostics or excluding the test is not acceptance.
That repair now gates the unsafe pinned-Pion selected getter on the transport's
atomic start-state publication and rejects close/replacement during collection.
It retains the exact selected/full/selected identity checks and complete receive
counters. Four added regression tests include the actual unstarted Pion object.
The final full Go internal/CLI race invocation passed 996 tests across twenty
packages with no failures or skips. The same nine exact disposable stress-test
Keychain markers were verified and removed afterwards; no device credential key
was read or changed by that guarded cleanup. The full required manager command
is being repeated only after this actual code repair, under the original explicit
coordinator and built-Harness inputs.
The repeated complete five-case manager command passed in 206.403 seconds,
including the previously failing alternating-offline case in 27.67 seconds and
both initiator-direction reconnect cases. This result supersedes the repaired
race only; it does not turn the retained original failing run into a pass, nor
does it prove physical core-crash recovery or overnight ICE reliability.
Independent review accepted the diagnostics fix and its race coverage, but found
one further test-only teardown defect before the physical run: runtime stop and
authenticated owner shutdown shared one 35-second context. A stop timeout could
consume the guard's once-only cleanup without actually shutting down the owner.
The owner teardown must receive a fresh bounded cleanup context while preserving
the original stop failure. This is not permission to extend the 25-second
application recovery budget or to use a direct child kill as a substitute.
The independent-budget repair and its exhausted-stop deterministic regression
passed review and twenty race rounds. The runner now reserves ninety seconds
after the unchanged 250-second crash scenario for exact-owner cleanup only;
its outer Windows process limit is 340 seconds. Actual recovery at 25000 ms
still fails, and the 45-second read-only failed observation is unchanged. Six
explicit Node tests pass, including the actual outer-command/verifier boundary.

The next physical run started at 2026-10-19T10:26:43.467Z in the new
`core-crash-runtime-owner-20261019-v0191/` evidence directory. Runner
`f6996f6a-321f-49bc-a761-79876e0cd6dc`, PID 76385, run
`c374154e-e54e-4681-9562-77b41a1c8367` uses frozen source digest
`758e048c8e4e2b43ee2ed5a260f5a4fe25b72b25834d593e56e78277ebcbebae`.
This line records a started attempt, not a passing crash/overnight/UI result.
That run finished failed at 2026-10-19T10:28:44.337Z with source unchanged.
The exact test core 76388 was killed and joined; core 50540 restored in 584 ms.
Owner 10280/epoch `441daf29c479c6daaf19867226cee3e4`, original real DSH 69744,
running launch, binding generation 1 and console cursor 4 all remained intact.
There was no missing-runtime/binding refusal after this repair. Nevertheless the
unchanged 25-second automatic recovery gate failed. The retained 45-second
observation showed later transport/runtime ready, not an accepted original-session
business readback. The apparent 37-second subtraction crosses the two hosts'
wall clocks and is not a valid elapsed duration; Windows monotonic timeout is
the acceptance evidence. The original Mac attempt terminated
with grace-expired at 10:27:56.6379Z; the later attempt reached ready at
10:28:01.860Z. The root cause of this delay is being investigated separately
from the now-retained runtime owner.
Same-Mac-clock refinement: ICE disconnected at 10:27:36.637Z, grace expired at
10:27:56.637850Z, the periodic five-second sweep began a fresh connect at
10:28:00.867767Z, and ready followed at 10:28:01.860088Z. Detection-to-ready was
25.223 seconds, before adding the pre-detection ICE idle interval. The exact
matching cross-host handshake logs show clock skew; do not subtract Windows
restore wall time from Mac ready wall time or label later transport-ready as
business acceptance. Production event/readiness boundaries are under review;
no grace, recovery criterion or polling timeout has been shortened or relaxed.

The exact held DSH was stopped through production runtime.stop and verified
reaped; authenticated owner shutdown was joined. `normalCoreExitProven=false`
remains explicit. Windows TestCrossClient failed in 77.83 seconds; the Mac host
was interrupted by failed-run teardown, not recorded as a successful business
seal. No new cleanup error appeared. No automatic rerun was started.

Read-only native-UI preparation found no safe complete candidate-ledger producer:
the existing remote-tab interaction contract is diagnostic, its required seven
prerequisite artifacts and raw ledger are not yet populated, and the development
smoke's directory environment variables are not consumed by the main entry.
Packaged smoke exercises only rendering/route/height and may still open the
shared Mac Keychain namespace. None of those smoke paths has been run as a
substitute for native interaction acceptance. No installed Launcher was opened,
stopped or replaced for this preparation.
No tag, push, release or installed-client replacement has occurred.

## Incident and scope

The user reported that Windows could initially use the Mac workbench, but an
overnight idle interval left the browser unavailable despite a connected device.
Both installed clients were 0.1.90. Read-only SSH diagnosis found the original
Windows gateway still listening, returning immediate HTTP 502 with
`p2p.reconnecting`. The Mac DSH remained responsive. No installed process was
restarted, and no original device, network, or pairing was deleted or recreated.

The two logs correlate session closure at 05:00:39 (Asia/Shanghai), then attempt
`e078d934591f` reaching transport-only connected at 05:01. The Windows gateway
remained detached. Subsequent bounded readback of the original Windows trace
places the earlier ICE disconnection at 05:00:19; see the incident refinement
below. Initial network loss is not yet attributed; the workbench restoration
defect is source-confirmed and independently reviewed.

### Original-incident refinement after tab controls

The user explicitly reiterated that manual tab closure/reopening is not the
root-cause repair or its acceptance criterion. This pass changed no production
code, runtime, permissions or network settings.

The original Windows diagnostic log is approximately 2.8 GB. A whole-log
PowerShell reader was stopped by its uniquely identified task-owned PID; all
subsequent reads used bounded Node byte windows (13 reads, about 34 MB per query)
with timestamp-window coverage reported explicitly. No log file was truncated,
rewritten or copied in full, and no payload/token/key was requested.

Original Windows UTC events, corresponding to local 2026-10-19 05:00:

- 21:00:13.760 and .875: valid nominated IPv6 candidate-pair traces still arrive
  for the two directions through the ZeroTier interface.
- 21:00:19.594 and .864: both ICE/peer connections enter Disconnected.
- 21:00:39.618 and .879: the original initiated/answered sessions close. This is
  approximately the existing 20-second application grace after ICE loss, not
  the first packet-loss event. Cleanup-time socket read timeouts/closed-socket
  messages occur after closure and are not established initial causes.
- 21:00:40.157 onwards: the original browser gateway logs `p2p.direct_closed`.
- 21:01:14.504: attempt `e078d934591f` becomes connected; the Mac confirms the
  matching transport-only request with no workbench attachment. This separately
  corroborates the already implemented restoration defect.

No matching Windows System/NetworkProfile/WLAN event was returned for the narrow
failure window. The Mac's narrow unified-log query found no sleep/wake/interface
event; its legacy pmset store was unavailable. The coordinator service reports
the same process start since October 17 with zero service restarts; narrow
server journal queries found no matching restart/network/error entry. These
negative queries do not prove network reachability, exclude all sleep/adapter
events or establish why the existing UDP paths stopped receiving responses.

Independent source audit found no hour-scale idle lifetime for the DataChannel,
mux or upgraded WebSocket. ICE keepalive and lease renewal run independently of
browser business traffic. It did confirm two narrower issues, not an attributed
overnight cause: post-ready termination discards the transport error in the
stage log, and the 20-second grace callback lacks ownership fencing if a timer
already began running when Connected stops it. The latter needs a deterministic
boundary test before any claim or patch; no observed reconnect-before-expiry
sequence establishes that race in the original incident.

Next root-cause evidence must preserve the first terminal reason and trigger,
last successful lease renewal/expiry, ICE/DataChannel state and last receive
time for the same attempt. Neither the separate fresh-process UDP nomination
failure nor manual tab reopening substitutes for that incident correlation or
multi-hour original-session acceptance.

## Approved contract

OpenSpec: `repair-open-workbench-reconnection`.

- Preserve only an admitted explicit outbound workbench intent, scoped by the
  exact service and pair, within the current core process.
- Restore its workbench and original local gateway after transient loss.
  Background pairs with no workbench request must not invoke the runtime owner.
- Reuse the existing backoff; a requested workbench is not satisfied by a
  transport-only connection. Claim concurrent attempts atomically.
- Clear intent on explicit disconnect, revocation, service removal, and close.
  Old attempts cannot install or detach a successor's attachment.
- Add core-authoritative, read-only `peer.entry` readback. The existing renderer
  entry operation validates current scope, generation, ready stage, isolated
  partition and loopback entry rather than relabeling an old cached URL.
- Keep automatic resume distinct from manual opening through a peer capability
  and `runtime.resume` owner callback. Automatic recovery only reattaches a running
  DSH; it cannot undo an explicit Stop. Missing resume support fails explicitly
  rather than downgrading to a runtime-start request.
- Preserve all installed production state. Candidate tests use isolated roots,
  test-only identities and independent production core/coordinator/DSH processes.
  This repair request does not authorize publication or installed-app replacement.

## Verification record

The manifest classifies this as data-critical connection/authorization recovery:
the changed workflow is automatic and adds no public control, input gesture,
layout, or interaction timing contract. Existing tab-navigation projections get
focused stale-result tests. Physical core/network execution and application
readback remain separate from desktop UI and latency acceptance; no visual or
performance acceptance is inferred from these checks.

### Test isolation correction

Early local real-process tests used temporary data roots, but the existing Darwin
credential provider ignores that root and uses the shared `dshkerd` Keychain
service. A later `serve` diagnostic enumerated stored credentials, restored the
original device and displaced its signal subscription. The original core logged
successful repair after displacement; its PID, original DSH PID and start times
were unchanged. These early runs are not accepted as isolated runtime proof.
No production credential values are included in artifacts.

All affected temporary processes were stopped by their recorded test-owned PIDs.
The live test helper now refuses credential-owning Mac execution before spawning.
Final physical recovery runs a Windows production `serve` core using a temporary
DPAPI data directory and its actual periodic loop; the Mac target is a production
peer manager with a test-owned DSH and coordinator. No named retry/reconcile calls
stand in for that periodic loop. This does not claim both desktop applications or
the Mac headless credential path were physically accepted. Missing-provider Mac
boot was diagnosed but correctly refused device restoration; no credential
fallback or provider shim was introduced.

Seven service IDs were independently attributable to this task's early test logs.
Their temporary loopback-coordinator credentials and certificate sidecars were
removed through the existing secret-store API. The unowned index entries were
preserved, and the original machine key, device credential and certificate
metadata were verified byte-for-byte unchanged. Evidence:
`.run/open-workbench-recovery/test-owned-credential-cleanup.log`. Unknown older
entries were not deleted or assumed to belong to this task.

### Covered checks and retained failures

- Full Vitest: 1688 passed, zero failed/pending. Focused Electron/renderer
  admission, cancellation, resume and entry suites: 267 passed.
- Go internal packages and `cmd/dshkerd`: 915 tests passed with the race detector,
  zero failed/skipped, across 19 packages. This is not a claim that every Go
  integration profile was run; credential-owning Mac daemon profiles are unsafe
  with the existing global Keychain provider and are deliberately not accepted.
- Selected manager integration: bidirectional HTTP/WebSocket lifetime, reverse
  connection survival, alternating offline recovery, 40 repeated redials and
  real-DSH network revocation. The repeated-redial case uses a test DSH endpoint;
  it is not relabeled as real DSH application-state acceptance.
- Physical Windows production `serve` uses its own periodic loop, temporary
  DPAPI data and one explicit initial open. The Mac production manager hosts a
  separate real DSH. Every recovery reads the original workspace/session via
  HTTP and `/api/remote.mux`, preserves cookies and the local gateway, and checks
  new attempt/generation ownership. A temporary runtime refusal must recover;
  stopping the test DSH must leave it stopped with one total cold-owner call.
- The first physical three-cycle run failed on cycle 3 while ICE nomination had
  no confirmation. Candidate exchange had completed, but no selected pair/DTLS
  was observed. That failure remains in `physical-first-failure/`; its cause is
  not attributed to this change. The test's 25s observer cut off the production
  30s transport timeout, so it did not prove natural retry closure for that run.
- Diagnostics now collect both peers' ICE logs plus authenticated test-process
  stacks on timeout. The original 25s success threshold is unchanged; up to 45s
  of extra read-only observation cannot turn a timeout into a pass. The next
  three-cycle run and refusal/stop matrix passed (`physical-diagnostic/`).
- The first ten-cycle run passed every business assertion but failed cleanup:
  the test registered a duplicate stop and raced a second Windows Kill after
  process exit. That run remains failed in `physical-cleanup-failure/`.
  The recovery test now closes its RPC only; `launch` retains the sole recorded
  child cleanup, including early-failure paths. No production error was hidden.

Raw evidence is under `.run/open-workbench-recovery/`. The final default manifest
verification is **failed**, not accepted: cycle 10 in the second ten-cycle run
again exceeded 25s at ICE nomination. Full evidence remains in
`physical-ice-diagnostic-failure/` and `test-integrity-verify.log`.

For attempt `4de46d287068`, Windows emitted 155 nomination log entries, while
the Mac logged no corresponding `useCandidate:true` request. The Mac stack had
no manager/ICE lock wait or runtime-owner block. Its normal 30s timeout occurred
at 09:41:15.426; automatic backoff then created `5921a4911e96`, which reached
`ready` with runtime generation 1. That diagnostic observation did not read back
the tenth cycle's original application/session state and cannot count as a pass.
Thus natural retry was observed, but the packet delivery/processing root cause
remains unconfirmed. No production timeout, ICE filtering, forced relay, or
fallback was introduced to conceal it.

A further diagnostic-only twenty-cycle invocation failed its initial explicit
connect after 30.85s, before any recovery cycle; its logs are in `physical-pcap/`.
The planned bounded Mac UDP-header capture could not start because noninteractive
`sudo tcpdump` requires user authentication. No capture was made during that
invocation and no firewall or privilege setting changed. All test-owned
processes and scratch directories were cleaned.

### Current-version bidirectional verification

The user subsequently started the bounded Mac capture, and authorized testing on
both physical computers. A separate Windows PktMon session captured only UDP
between these two IP addresses with a 160-byte snapshot. That owned session was
stopped and its named filter removed after the first diagnostic; no existing
capture, firewall, or adapter configuration was changed. Raw evidence remains
under `current-bidirectional-diagnostic/`. A truncated packet or an incomplete
live-capture record is not evidence that a STUN nomination was absent.

Both peers use the current DSH 0.2.1-alpha.2 built CLI. Mac runs its explicit
system Node 22.23.2; Windows runs the installed packaged Node 22.23.3. Tests use
fresh, independently enrolled identities for two separate phases. The forward
stress phase keeps the original production Windows periodic-recovery driver.
The duplex phase additionally starts a test-owned, core-supervised Windows DSH,
opens the reverse workbench first, and checks each direction while the other is
invalidated. Reverse recovery exercises the production Mac manager's explicit
Reconnect operation; it is not presented as a Mac core timer or native UI test.

The first current-version diagnostic passed all three forward recovery cycles,
including original application/session/WebSocket readback, temporary refusal,
refusal recovery, and an explicitly stopped DSH remaining stopped. The separate
duplex phase failed before connecting: its Windows DSH exited before application
readiness. Its cleanup also reported a test decoder contract error caused by a
literal `launch,omitempty` field tag. The aggregate remains failed, with source
identity unchanged.

The next duplex-only diagnostic retained the actual startup error:
`ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-app-boot`, with stderr bytes 969 and
exit code 1. Its exact owned child was read back as reaped. The package source
manifest exists, but Node cannot follow the original dependency junction; a
standard junction created in a temporary directory can read that same target.
The installed directory is not modified. A same-version temporary source copy
retains the identical CLI hash; frozen installation with both the bundled pnpm
and the exact installed pnpm 11.28.5 failed because registry requests could not
resolve/connect. The exact test-owned install process was stopped; its failures
remain in `windows-test-harness*-install.log`. Dependency preparation is not
reported as runtime or reverse-workbench acceptance.

Diagnostic status-envelope parsing now strictly handles present/absent variants
without literal optional-field tags. Startup logs are bounded to 16 KiB, remove
an incomplete first line when truncated, and redact credential lines including
standalone Bearer values. Two sentinel-only pure-function regressions pass; an
independent review closed both cleanup and redaction findings. No production
protocol decoder, launch timeout, or recovery success criterion was relaxed.

The isolated dependency copy subsequently passed: 106,805 ordinary files,
8,805 rebuilt internal links, zero external links, one declared Windows native
binary, and the same CLI hash. All writes stayed in a new Windows Temp child;
no installed source, cache, account or network state was rewritten. A real
core-supervised Windows DSH then started successfully in the full matrix.

The next default verify (`test-integrity-verify-current.log`) remains **failed**.
Its first five commands passed, including 1,688 Vitest, 915 Go race tests, selected
manager integration and source builds. Physical `forward-stress` passed all ten
recovery cycles, but the later temporary-refusal recovery exceeded the unchanged
25s threshold. For attempt `f27621e3b802`, both captures contain matching complete
nomination packets with valid IP/UDP checksums. The Mac actually processed two
initial nominations, selected the pair, then failed its response writes with
`sendto: no route to host`; subsequent DTLS/keepalive writes had the same error.
The earlier hypothesis of no Mac application receipt is not valid for this run.
No historical route/ARP/socket snapshot proves why the OS refused those writes.
See `physical/f276-packet-analysis.md` and its hashed transaction evidence.

The independent duplex case reached both real workbenches and preserved the
opposite direction through both direction-specific invalidation/recovery checks.
It later failed the reverse WS readback. The control HTTP EOF was downstream of
that assertion ending the host test, not the first error. The Go test client had
stopped reading between assertions; coder/websocket requires a continuous reader
to process protocol Ping/Pong, and the real DSH gateway has a 2s heartbeat. This
is a test-driver defect, not evidence of a production cross-direction close.
The reader is now owned for each connection's whole lifetime, with bounded
business-message handling, exact-connection error scope and joined cleanup.

Audit of the previous physical profiles found **zero seconds of controlled real
DSH application idle**. Raw-transport lifetime tests are not web-session idle
acceptance. The candidate test now explicitly requires 60–600 real idle seconds;
the default gate selects 300. Both directions must make zero gateway HTTP/WS
application sends while their readers handle protocol heartbeats, then read
back the original WS, cookie, session, gateway, attempt and runtime identity.
This is only a five-minute baseline when actually executed successfully, never
an overnight claim. New default evidence uses `physical-idle/`; prior failed
`physical/` evidence is retained unchanged. Multi-hour evidence is still missing.

The default true-idle verify completed at 04:28:03 UTC and remains **failed**.
Its independent duplex case passed: Mac-to-Windows idle 300.035749s and
Windows-to-Mac idle 300.000378s, both with zero gateway HTTP and WS application
writes. The original WS IDs, cookie digests, workspace/session, attempt and
runtime identity survived; new follow responses were read on those exact WS
connections afterwards. Subsequent direction-specific disconnect/recovery,
temporary resume refusal/recovery, opposite-direction survival and stopped
runtime checks passed. Both real DSH processes were test-owned and reaped;
cold owner calls remained one. An independent read-only audit matched the
source digest, candidate hashes, raw-log hashes and assertions. This accepts
the candidate physical five-minute scenario only, not overnight stability,
installed desktop UI or a Mac core periodic-recovery loop.

The same run's forward-stress phase failed its initial explicit connection after
30.85s, before any of ten recovery cycles. Exact Mac UDP port 65365 to Windows
64115 reported `sendto: no route to host`. A bounded, read-only watcher captured
route, ARP, UDP socket ownership and source-interface state at that error: route
UP through feth1266, peer ARP present, the correct test process owning the source
socket, and interface index 18 active with the correct source address. Similar
write errors also occurred on unused duplex candidates despite the duplex
application case passing. These facts do not prove a permission, ZeroTier,
route-cache or application defect. A narrow unified-log query produced no
matching policy event; absence there does not establish permission approval.
No route, adapter, firewall, privacy permission, ICE filter or timeout was changed.

Independent packet review distinguishes this first-connect failure from the
earlier f276 attempt: all 27 complete Windows nomination transactions match the
Mac capture (156 total complete nomination packets, valid IPv4/UDP checksums and
correct destination MAC), but none has a corresponding response. The Mac logged
one initial exact-pair EHOSTUNREACH; it subsequently processed and answered an
ordinary STUN request, while no nomination receive trace or selected pair was
recorded. Thus delivery to the interface is established, application receipt of
the nominations is not. The first write error is not a proven explanation for
all later absent responses. The normal OS snapshots followed that first error
by approximately 91–168ms, not an atomic kernel-policy observation.

Latest packet evidence is `physical-idle/mac-udp-snapshot.pcap` (SHA-256
`7102552bd6db1e57ce25265a0e2a628c872a7936196bd8f727ef292c1e777662`)
and `physical-idle/windows-udp.pcapng` (SHA-256
`7f82216c03d716a9f04ccb51b6458eafb197b76bd66b5054477e1adaf77614da`).
The owned Windows capture and its named filter were stopped/removed; status
confirmed no capture and no filters. The user-started bounded Mac tcpdump was
stopped after collection, and both read-only route watchers ended. Native
privacy-settings inspection was unavailable because the Mac was locked; no
unlock or permission change was attempted. Original Mac Launcher/core/DSH and
Windows core/Node PIDs and start times remained unchanged. Prepared isolated
Windows Harness inputs remain in task-owned Temp directories for follow-up;
no test service is intentionally left running.

### Acceptance boundaries

Application environment, formatting, architecture, types, service/visual source
smokes, renderer/Electron source builds, strict OpenSpec, 67-file source-size
gate and the desktop app validator pass. Production source bundles and core
dependencies do not include the new integration fixtures or diagnostic routes;
see `production-artifact-isolation.json`. This is not an installer/package audit.

The required parent/global checks were run and remain red: the desktop framework
gate reports 674 issues, including missing DSHKer registration and unrelated app
violations; the workspace aggregator also reports other failed workspaces and
missing tooling. The workspace documentation-path check reports existing issues,
including five unchanged Launcher documents. These are blocking workspace gates,
not warning downgrades or an all-workspace-green claim. No parent or unrelated
project files were changed to suppress them.

No native desktop UI, overnight-duration, new installer, publication or installed
client acceptance is claimed. Original installed Launcher/core/DSH process IDs and
start times remain unchanged. A listening port or generic HTTP 200 cannot replace
the application/session and WebSocket readback above.

### First-cause instrumentation and deterministic race repair (06:00 UTC follow-up)

The original Windows log was inspected with bounded timestamp-indexed reads,
not a full read of its 2.8 GB diagnostic file. ICE/PC Disconnected at
21:00:19 UTC preceded the session close around 21:00:39 and subsequent
`remote.mux` errors. Later candidate nomination traces do not establish that the
actually selected path stayed healthy. No fixed multi-hour application idle
expiry was found. These facts distinguish the original ICE interruption from
the separately repaired transport-only workbench recovery defect; they do not
identify the original network-level cause.

Transport now freezes its first failure before cancellation, with state,
accepted lease facts and atomically paired selected-path/receive samples.
Selected scope is checked before and after the full Pion report; the selected-
only getter omits STUN statistics and is deliberately not treated as authoritative
receive evidence. Missing facts remain unknown. Scoped IPv6 addresses are
supported. Raw candidates, SDP, credentials, URLs and application payloads are
excluded. The one-second stats worker is joined on Close; callbacks never run
GetStats or consume the legacy Errors channel. Mux Err is a non-consuming read.

Session diagnostics retain exact service/pair/attempt/generation/direction,
the first owner stop and earlier transport failure, plus last lease attempt and
success. Terminal snapshots are frozen before teardown and emitted after owned
workers join. Read-only observers emit changes and bounded minute summaries,
including selected-path changes with their sample timestamps, not business
HTTP or WS probes.

A deterministic RED test confirmed a separate timer race: stopping an AfterFunc
does not prevent an already-started old callback from closing a recovered
transport or a newer grace window. Grace epochs now fence that callback under
the existing lock. The 20-second grace and recovery deadlines are unchanged.
Focused race, full peer race and all 19 internal/CLI package race checks pass.
The original overnight event cannot yet be attributed to this race.

Independent review verified first-cause/join/lock behavior and the long-profile
contract. Its scoped-IPv6 finding was corrected and retested. A new physical
preflight uses a fresh `first-cause-preflight-20261019-1410/` evidence directory,
three recovery cycles and 60-second real bidirectional idle; it is not the
required 8-hour/10-cycle gate. The manifest now requires 28,800 seconds and a
new non-overwriting evidence directory. Long-profile resources are checked
against their actual expiry, and progress cannot reset the original WS, cookie,
session or runtime. Neither profile changes production TTL or operation budgets.

Original installed processes and Windows Harness fixture hash were rechecked
unchanged before this preflight. Mac isolated tests continue to use the production
Manager without opening the shared credential-owning Keychain core. Noninteractive
sudo is unavailable; the user was asked to start a bounded dual-stack packet
capture locally. No password, network permission, adapter, route or firewall
change was made. No new release or installed-client replacement is authorized.

The short preflight completed failed with source unchanged. Forward cycles one
and two passed, cycle three timed out during ICE selection. Independent duplex
opened Mac-to-Windows, then Windows-to-Mac failed initial selection, before any
idle duration. The Windows capture is retained as
`first-cause-preflight-20261019-1410/windows-udp.pcapng` (SHA-256
`186c53f6bbecac53d5063e14d73b03d9f1bc1d8d1609860e7afc4d8acf4ece9c`).
Offline analysis of that duplex failure found 27 unique IPv4 nomination
transactions, each repeated across capture layers, without a matching response
in this capture. The capture ended two seconds before the deadline and no Mac
capture existed then, so neither full-window silence nor Mac application receipt
is established. The new ignored dual-stack parser keeps the original parser
unchanged, has synthetic self-tests and matching legacy IPv4 regression, and
never prints STUN attributes or payloads.

The eight-hour candidate runner started 06:08:16 UTC, PID 29138, runner identity
`ec4b78d8-36f9-4325-a85c-0d1781ba3dcb`, source digest
`f5dffec200a854532e5a2b34fd83a290146f991dd10d7a1df4db21c8f9109394`.
Evidence root: `first-cause-8h-20261019-1410/`. This is not a replacement passing
run: its forward stress case passed seven cycles, failed cycle eight at the
unchanged 25-second criterion, and the overall result must remain failed even
if independent idle succeeds. One commentary prematurely described ten cycles
complete; it was promptly corrected from the raw log. All failures remain raw.

The independent duplex case did establish both original sessions. Genuine idle
began at Mac 06:10:57 UTC (Windows clock is approximately six seconds behind),
with WS IDs `7a6dbd0e729f` and `0d2fe8e10050`, runtime PIDs Mac 59587 / Windows 61400. By 06:16 UTC both directions recorded 300 seconds, original WS true,
unchanged attempt/generation/session/runtime and zero business HTTP/WS delta.
Only metadata/control readback and standard protocol heartbeats occur during
idle. Required elapsed remains 28,800 seconds; expected idle completion is about
22:11 Asia/Shanghai, followed by recovery/refusal/stop assertions, not yet passed.

After a truncated MAC address was corrected by the user, Mac tcpdump PID 65011
was confirmed running from 06:11:40 UTC. It covers dual-stack UDP and neighbor
traffic on feth1266, rotating four 20 MB files at `first-cause-dualstack.pcap*`.
Thus it does not cover the earlier pressure failure or first idle minute.
Windows owned PktMon `dshker-firstcause-long-20261019.etl` is 64 MB circular,
filter exact name `dshker-firstcause-long-20261019` (table display truncates it).
No unrelated capture may be stopped. Heartbeat automation `dshker` checks this
exact runner/evidence quietly every five minutes, reporting new failure,
completion or required user action. It must preserve the first failure and only
clean up verified test-owned processes/captures. Original installed Mac/Windows
PIDs and starts remain unchanged; original credentials were not opened by the
isolated Mac core.

Fresh app tests pass 1702/1702 with no pending tests. Nineteen internal/CLI Go
packages pass race; final peer/session race, long-profile pure units/race,
environment/architecture/types/format, source smokes/builds, strict OpenSpec,
83-file size gate and desktop app validator pass. Test-integrity static passes.
The fresh default verify remains failed: its manager-integration command refused
missing explicit coordinator/Harness environment inputs. This is not a green
acceptance result, and the command was not weakened or skipped. Multi-hour,
complete pressure and native UI gates remain open; no release is authorized.

### User-requested transition to isolated fault injection

At 07:01:10 UTC the user-requested finish ended the eight-hour runner through
its authenticated test-only finish operation. The original two sessions reached
about 3,000 seconds of genuine idle, not 28,800 seconds. Its earlier cycle-eight
forward failure remains the first failure and aggregate failed. The source was
unchanged at finish. No scenario was overwritten or rerun until green.

Both task-owned captures were stopped after exact PID/command or PktMon
path/filter verification. The copied Mac pcap hash is
`d759ff2eea567bcfb3e1a6bf4d79fc608fcabdec771ed6ece48d93c102f2eb1d`;
Windows pcapng hash is
`0e15840ad6ea10efbac1925c74f04f34e4ce21bd01a82552a52f7b58a8b3be22`.
The Windows capture reports no lost events and 163 packet-drop records; these
different counters do not by themselves identify network packet loss or cause.
The old heartbeat is paused; it must not restart that completed scenario.

The user approved short 3-second loss, long 35-second loss and repeated
3-second loss/3-second restore, limited to UDP for a fresh isolated Windows
test-core executable. Five independent cases cover inbound/outbound short and
long loss, plus five bidirectional flaps. Original installed processes,
credentials, network adapters, power policy and production services remain out
of scope. There is no new permission to publish or replace installed clients.

The test-only PowerShell controller uses exact executable hash, PID, parent and
creation time. Disabled rules are read back before enabling. A separate
current-user scheduled task has a fixed deadline no later than 90 seconds from
controller creation; the deadline is never renewed. A disabled-probe preflight
must prove the future task executes after its exact controller is killed before
any enabled blocking rules are permitted. This is a cleanup safety check, not
peer-process crash recovery. Ownership tags prevent removal of preexisting
objects. First failure and cleanup failure are retained separately; incomplete
receipts fail. JSON records publish atomically, with no decode-error retry.

Both test peers use production automatic recovery: Windows real serve and Mac
production Engine plus Manager with a temporary real catalog. Mac full serve is
still forbidden because its credential provider uses shared Keychain state.
After the one initial open, no observer Connect, RetryNow or manual Reconnect
drives recovery. The 25-second criterion starts at the first rule-removal
attempt. Long loss can naturally destroy a WebSocket; a new carrier must read
the original Cookie, gateway, workspace, session and runtime. This must not be
reported as continuity of the original WebSocket or native browser recovery.

At this note's update, pure race checks and the actual Windows PowerShell parser
pass. Independent review corrections cover object ownership, first-error
preservation, full-enable timing, strict receipts and atomic publication. The
future-task crash proof and enabled UDP physical scenarios are not yet passed.

### Physical fault-profile result and explicit process-crash pivot

The disabled-probe future-trigger preflight passed in 94.70 seconds: exact
controller PID 50164 was killed and joined; the independent task produced its
deadline-cleanup receipt at 07:57:56.256 UTC after deadline 07:57:55, then Close
confirmed rule/task absence. This proves cleanup after controller death, not
peer recovery. Its preceding failed preflight remains separately recorded:
Windows PowerShell 5.1 bound File.Replace's `$null` backup path to empty string.
The explicit .NET NullString fix passed an independent actual-Windows repro;
the failure had created no rules or task and its test core had stopped.

The five-case physical UDP run then finished failed with source unchanged,
digest `fa7e43e26c9183bb18235c668fa5a147c642f03c4cb8f251c12a32692426b641`,
runner 84705 / `aea3e9a9-c004-44b4-b0fb-8677274ed556`, 07:58:51–08:05:11 UTC.
Evidence: `network-fault-20261019-guarded/physical-verification.json` and raw
per-case logs. No result is accepted as successful weak-network injection.

Read-only Windows policy inspection found Domain enabled but Private and Public
disabled; ZeroTier uses Public. Thus an Enabled rule readback did not prove any
actual UDP interruption. The short and flap business readbacks alone are not
outage recovery evidence. The long-inbound attempt stayed ready and unchanged;
its forced-new-attempt requirement correctly failed after 25 seconds. The
long-outbound case separately failed initial ICE before any injection. The user
explicitly declined enabling the firewall and requested an isolated process kill
instead. Policy is unchanged; future injection now refuses disabled active
profiles and cannot silently choose another mechanism.

Short-case aggregate failures also exposed a test-only teardown bug. At Mac
07:59:38.475 original WS readback passed, `/finish` returned at .502273,
deferred manager Close fired at .502366, and the unsealed browser reader then
received EOF at .502598. This is not an observed business-time disconnect.
The original failure stays failed. A strict healthy-carrier seal/close/join
before owner teardown is required rather than masking errors with expectLoss.

Offline review of the earlier eight-hour pressure failure found another
connected-to-disconnected event, distinct from its cycle-eight initial ICE
failure. Mac original JSONL lines 3841–3857 show attempt `8e08ae07f9c9` answered,
selected IPv4 Mac port 61436 to Windows port 52609. Last recorded STUN receive
was 06:10:08.145/.150 UTC; a write on that exact selected tuple returned
EHOSTUNREACH at 06:10:10.163; lease renewal succeeded at 06:10:11.753, before ICE
Disconnected at 06:10:14.156. Test interruption only occurred at 06:10:26.223.
The selected-path error therefore predates cleanup and is not an unrelated
candidate warning. It still does not prove why receive stopped roughly two
seconds earlier, or that cycle-eight initial nomination failed for the same
reason. Mac capture began later and cannot establish delivery for this window.
Two narrow OS unified-log queries returned no matching entries. Same-transaction
packet matching estimates Mac clock about 6.55 seconds ahead of Windows;
cross-host log differences must not be called network latency.

The next authorized case kills/restarts a test-owned production Windows core
without any firewall operation or installed-process mutation. Its actual core
runtime supervisor and restore behavior must be tested, not replaced with a
test-parent owner that would conceal lost runtime supervision. A missing restore
capability or runtime_unavailable remains a failure, not manual re-enrollment,
another runtime start, or an inferred successful workbench resume.

### Actual isolated core crash result — failed, no automatic rerun

The single `core-crash-20261019/` run finished failed at 08:53:54 UTC with source
unchanged, digest
`be76b4b49cb50ee3da9c84ba708b76cdfed13ac4eb6a7aa6a2dc7c5cccb76eba`.
Runner 59649 / `f556bba7-bf43-4e3f-a3bc-f2e6a855502b` used the exact original
coordinator and current Mac/Windows DSH inputs. Strict read-only independent
review and focused race/Windows compile gates preceded this physical execution.
No firewall operation was part of the crash scenario.

After the original Mac-to-Windows application/workspace/session readback, a held
Windows process HANDLE verified test core PID 10136, parent 58396, creation and
candidate hash before TerminateProcess. The actual cmd.Wait channel was fully
joined. New core PID 5504 started with the same Args/Env/state/data/catalog/roots
in 628 milliseconds and logged production restoration of the exact device and
service. The persisted catalog was identical; directoryKnown=false remained
explicit rather than being fabricated through account login.

Original test DSH PID 30056 remained alive. The restarted real core nevertheless
reported `runtime.status present=false` and `core.runtime_binding` returned
`p2p.runtime_unavailable`. No runtime.start, device.restore or peer.connect was
replayed by the observer, and no old binding or parent-owned runtime replaced the
new supervisor's actual state. The first 25-second threshold failed. The
additional 45-second read-only observation retained that failure.

These are two distinct recovery boundaries. The first automatic attempt had not
started by the 25-second criterion: loss detection, the unchanged 20-second grace
and five-second sweep consumed that interval. Mac same-clock evidence records
old attempt disconnected at 08:52:47.427, grace expiration at 08:53:07.169, and
first production-engine retry at 08:53:11.638. The old lease had renewed at
08:53:00.431. Subsequent automatic attempts did reach transport-connected but
five resume attempts were refused with `p2p.runtime_unavailable`; the missing
running-child/binding record is therefore a confirmed additional recovery gap,
not a sole attribution of the first timeout or the original overnight ICE loss.

The test retained the original runtime handle and cleaned only PID 30056 through
that handle, confirming reaped=true. It did not treat a new supervisor's absent
record as proof of child exit. Both task-owned packet captures have stopped:
Mac full copied pcap SHA256
`3b7450f5adbaf27e3ff99a728d3f113f2de3073f0345498bd56ab0a9df920094`,
Windows pcapng SHA256
`0ae1c2100ded9d1219fc661f93298b6878a5049d9562648010b9ee929a0625c0`.
Windows reported no lost capture events and 15 packet-drop records; these are
different counters. Only the exact task-owned PktMon filter was removed. Mac
tcpdump PID 79912 was interrupted only after its exact command/owner/start time
was rechecked. No installed core/DSH, firewall policy, adapter or credential was
modified. The old heartbeat remains paused; there is no following live run.

This turn adds truthful tests and first-cause evidence, not a runtime-adoption
repair. Core-restart application recovery, original overnight cause, eight-hour
idle, native UI and release acceptance are all still open. No publication is
authorized, and no failing run or original evidence was replaced.

Final read-only OS audit confirmed Windows test PIDs 10136, 5504, 30056 and
58396 absent, with original PIDs 46452, 46508 and 45556 unchanged in executable,
parent and creation time. Both Public and Private firewall settings remain
disabled. The Mac audit confirms known test DSH 61032, runner 59649 and capture
79912 absent, no remaining integration-test/coordinator/tcpdump process, and
original Launcher/core/DSH starts unchanged. See `core-crash-cleanup-audit.log`
and `core-crash-20261019/mac-cleanup-audit.json`. Current source digest still
matches the executed candidate after these documentation/evidence updates.
