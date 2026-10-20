## 1. Go recovery owner

- [x] 1.1 Core owner: retain admitted outbound workbench intent and clear it on explicit disconnect, revocation/removal and close; verify focused lifecycle tests and transport-only owner-call counts.
- [x] 1.2 Core owner: retry until intent is satisfied and atomically prevent overlapping reconciliation; verify runtime-refusal recovery, backoff, and concurrent race tests.
- [x] 1.3 Core owner: fence attachment installation/cleanup and preserve the original gateway across transport replacement; verify stale completion and bidirectional HTTP/WebSocket tests.
- [x] 1.4 Core owner: add scoped read-only peer.entry returning current ready state and gateway; verify stale/non-ready/revoked/invalid admission without a runtime-start side effect.
- [x] 1.5 Core/desktop owners: distinguish automatic resume from manual cold start across peer capabilities and runtime.resume admission; verify running targets resume, stopped targets never start, and unsupported peers fail explicitly without downgrade.
- [x] 1.6 Transport owner: retain credential-free first failure/state/receive timing and fence the grace callback against recovery/supersession; prove first-writer and deterministic expiry/recovery interleaving under race tests.
- [x] 1.7 Session owner, after 1.6: log causal termination boundaries and lease renewal facts with exact attempt identity, without hiding the transport cause behind teardown or unbounded tracing; verify redaction and lifecycle tests.
- [x] 1.8 Runtime owner: implement the independently authenticated child authority and strict private-record admission; retain real child/pipes/binding across core crashes without PID/URL adoption, credential access or a second owner. Unit/process-boundary proof is complete; real DSH physical acceptance remains separately under 3.8.
- [x] 1.9 Core/CLI owners, after 1.8: wire both production entry points to that authority, preserve typed failures, keep resume bind-only, and explicitly join runtime ownership on normal shutdown; verify Stop, fixed-port and failed-boot boundaries.

## 2. Desktop entry recovery

- [x] 2.1 Desktop owner, after 1.4: resolve existing entry IPC through core readback with exact scope, lifecycle, loopback and authorization checks before/after awaits; verify focused Electron admission and readback tests.
- [x] 2.2 Desktop owner, after 2.1: remount an already opened tab only for current ready generation and stable pair partition, rejecting superseded/revoked lookup results; verify renderer recovery tests.
- [x] 2.3 Desktop owner: add remote tab close/keyboard/focus behavior and add-menu reopening/SSH reconnection without stopping DSH; verify current/background tabs, pending/late results and record preservation through component tests. Native interaction acceptance remains under 3.3.

## 3. Verification and handoff

- [ ] 3.1 QA owner, after 1/2: run isolated real coordinator/core/DSH auto-recovery with original session/workspace readback, HTTP cookie and WebSocket traffic; record generations, attempts and stable gateway through repeated loss without a second explicit connect.
- [ ] 3.2 QA/root, after 3.1: run isolated macOS and Windows candidate evidence without touching installed credentials or active DSH; report exactly what cross-machine/runtime tier was exercised and any missing physical UI acceptance.
- [ ] 3.3 Root: add CHANGELOG, correct both READMEs, Agent Note and a complete test-integrity manifest; pass strict OpenSpec validation, source-size, relevant full tests, source builds, architecture, desktop validator and default test-integrity verify.
- [ ] 3.5 QA/root, after 1.6/1.7: run eight-hour bidirectional original-session idle on the authorized physical Mac/Windows candidates, preserving early failures; diagnose the first actual ICE interruption without page reopening or installed-state mutation.
- [ ] 3.6 QA/root: under the user's D19-approved replacement profile, independently verify exact-owned program-pause cleanup after controller death, then 3s, 35s and repeated physical pauses/resumes with both production auto-connect engines and original business identity; preserve the 25s budget, untouched firewall and carrier/native-UI boundaries. Preserve the historical failed UDP profile without calling this UDP proof.
- [ ] 3.7 QA/root: following the user's process-crash instruction, verify exact-owned Windows candidate kill/restart with unchanged test roots, surviving-client automatic recovery and original application identity; preserve the killed-core intent-lifetime boundary and strict sealed teardown.
- [ ] 3.4 Independent reviewer, after final implementation: review the final diff and regress actionable findings; the earlier pre-owner review does not approve the new runtime architecture.
- [ ] 3.8 QA/root, after 1.8/1.9: prove runtime ownership survives a real core crash with original child/launch/binding/console and application session, continuous output, stopped-child refusal and exact cleanup; keep P2P/overnight/UI tiers distinct.
- [ ] 3.9 Root, after all required verification: commit only scoped files, run same-SHA Quality/Package checks and publish an unused stable version/tag with verified assets and bilingual Release body. Do not replace installed clients or publish while mandatory gates remain red or incomplete.

## 4. Joint control-v2 handoff (approved 2026-10-19)

- [ ] 4.1 Root/architect, before code: reconcile client and independent server plans with the signed candidate/registration wire, durable decisions and exact promotion ownership; verify both strict OpenSpec validators and independent design review.
- [ ] 4.2 Server owner, after 4.1: implement current v2 registrations, additive schema 7, durable idempotent candidate decisions and directed active CAS without v1 mutation; verify migration, concurrency, lost replies, server restart, authorization and HTTP/WSS tests in the server-owned change.
- [ ] 4.3 Client owner, after the shared wire is frozen: implement v2 admission/control requests, primary/candidate lifetimes, suspended state, candidate-only resume/probe, resolving and exact promotion/cleanup; verify deterministic races, original WS preservation, lost commit and bidirectional cases.
- [ ] 4.4 Client/root, after 4.3: wire event-driven reconciliation and typed suspended/readiness presentation with no cached ready; verify same-attempt recovery, stale events, active tab identity and strict main/preload admission.
- [ ] 4.5 QA/root, after 4.2/4.3: run real local Gin/core/DSH integration for primary recovery, supersession, restart, response loss and stopped-runtime refusal; retain exact source/artifact identities and update complete test-integrity manifests.
- [ ] 4.6 Root, after local integration passes: deploy only the verified Linux server artifact under the existing service, preserve port 8443 and identity/state through additive migration, and verify actual TLS, WSS registration and v2 client integration; retain a matching rollback snapshot.
- [ ] 4.7 QA/root, after 4.6: freeze source and repeat failed physical core-crash/recovery cases, original-cookie/WS/session/runtime bidirectional eight-hour idle plus ten recovery rounds; record any missing UDP/native UI tier honestly without removing its gate.
- [ ] 4.8 Independent reviewer/root, after final fixes: complete both diff reviews, full native/build/test-integrity gates and same-SHA CI packages, then publish the authorized stable release only if all mandatory current gates pass.
- [ ] 4.9 Client/server owners, before final freeze: implement explicit scoped v2 pair identity and read-only-registration/fresh-pin/candidate-capability bootstrap; verify real TLS selected-account B with enrollment owner A, stale fence/account changes, early prepare refusal, failed discovery without cached pins, and unchanged legacy v1 identity.
- [ ] 4.10 Client/server/root: implement unchanged-limit authenticated principal budgets and exact owned transient candidate/bootstrap recovery; verify real same-NAT cold startup, concurrent directory/candidate traffic, malformed action readback, throttled cleanup, missing-manager retry, account/removal cancellation and join without altering the recovery clock or original credentials.
- [ ] 4.11 Product/root/client: implement the user's approved D18 choice (retain freshly authorized saved network; explicitly choose an ambiguous first network) through scoped named operations and the existing add-tab floating dialog, without first-network inference or ignored pin errors; verify expected account/revision, revocation/reselection, unknown results, keyboard/focus, late completion and one-computer/tab behavior before release.
- [ ] 4.12 Client/root/reviewer: close the real cold-bootstrap committed→successor Prepared ordering race with target-only exact local handoff, including dead resources retiring without Ready or swallowed successor; verify the unchanged-deadline real two-Host/DSH case, plus fresh network selection's exact engine-terminal/in-flight invalidation.
- [ ] 4.13 Client/server/root, after preserving the first online failure: repair D20's matched Bearer-route TLS resource accounting and explicit account transport phases without changing limits or public certificate-recovery/authentication ownership; verify actual TLS same-NAT account/directory/candidate requests, selected B/owner A, denied sessions, expired credentials, exact cleanup and independent review before re-deployment.
- [x] 4.14 Client/root/reviewer: implement D21's single-operation canonical certificate adoption without removing fresh account checks or issuance readback; prove bounded real-TLS request counts, standalone independence and superseded/cancelled/closed refusal, then independently review before a new unchanged-limit cold diagnostic. Do not infer that this alone resolves device-source exhaustion.
- [x] 4.15 Client/root/reviewer: implement D22's explicit early-observer stop/join handoff and one-use same-call Ready receipt without mailbox/cache/WSS changes; prove exact request counts, all-exit joining, unknown action durable readback and current-active promotion/ordering boundaries before the next unchanged-deadline cold diagnostic.
- [x] 4.16 Client/root/reviewer: implement D23's shared denial-only selected-session scope across auth activation, both restore branches, catalog/network selection, background/AfterWrite, directory publication and named recovery projection; prove the complete actual-logout/late-publication matrix, independent typed job/session axes and genuine new-login/signed-out/ordinary-Bearer contracts before joint cold verification.
- [x] 4.17 QA/root/reviewer: repair D24's physical-driver initialization after preserving both D23 failed attempts: explicitly select the verified Windows fixture, retain one catalog enable, observe the actual automatic transport owner before the sole legal-generation business open, and prove deterministic setup boundaries without changing production reconciliation or recovery budgets before a fresh physical profile.
- [x] 4.18 Client/root/reviewer: after preserving D24's real 35-second pause failure, prove and repair answer-side terminal reservation versus cleanup ordering, including re-subscription's historical Prepared with a missing terminal event; retain one fenced, bounded and joinable admission owner, exact durable State proof and credential-free decision logs. Verify blocked End/transport cleanup, sequential Prepared/offer, unknown/foreign/pending/current-committed State, all authority changes and late cleanup. The final D25 joint race run passed 93 named Go tests with zero race/skip/failure after independent review closed the finish-first retirement-receipt race. This completes deterministic repair only; it does not claim physical recovery.
- [ ] 4.19 QA/root: repeat the physical program-pause and isolated core-crash profiles on the repaired exact source, then keep the original Mac↔Windows Cookie/WS/session/runtime in both directions for 28,800 seconds of zero-business-traffic idle and run ten production automatic recovery rounds. Preserve every result and the unchanged 25-second recovery budget; no manual reconnect, page reopen, DSH restart, relay or timeout change can satisfy this gate. Installed-app/native UI acceptance is recorded separately from source and physical headless evidence.
- [x] 4.20 Release: make the packaged-core smoke request the existing authenticated `core.desktop_attach`/`core.desktop_handoff` lifecycle before cleaning its isolated state, so Windows CI does not terminate the serving process forcefully while its independent runtime owner still holds `owner.log`; add protocol-focused Node tests to release-input checks. Both handshake success and refusal behavior pass local tests; cross-platform package CI is the remaining confirmation.

Current verification: D24 source 5cb2d390 passed the fresh source/TS gates (with
the retained prose-path validator failure and separately passing continuation).
Its physical program profile then failed: 3-second and repeated-short pauses
passed, but the 35-second pause exceeded the unchanged 25-second bidirectional
readback budget. Both packet captures and original failed logs are preserved.
D25 addresses the confirmed source-level admission/cleanup defect and missing
decision receipts; it does not yet claim the exact overnight cause or physical
acceptance. Source is unfrozen only for that evidence-supported work. Eight-hour,
crash, native UI and release gates remain open; no publication has occurred.

Historical verification as of 2026-10-20: at source 8cf38342, full20 Go race/vet
(1,493 named passes), 1,868 TS passes, local cold and mixed Manager integration,
and the actual online same-Mac two-Host/DSH case passed. Source/build gates have
two honest segments: the first operator stopped on an extra artifact guard after
seven passing checks; a separate continuation passed the five unexecuted checks.
These are not physical/native UI proof. The two fresh physical program-pause
attempts remain failed before business fault injection: the first selected the
wrong Windows Harness root; the second exposed duplicate catalog enable and a
fixed generation one racing completed production auto transport. D24 repairs
only that test initialization. The original-session eight-hour interval, normal
pause/crash recovery, native UI, default test-integrity verification and same-SHA
CI/release gates are still open. No separate macOS desktop environment is
available; the user confirmed this, not a waiver. After failed evidence was
preserved, the 8cf38342 freeze ended for the test-only repair; no new physical run
is currently in progress and no commit/push/tag/release has happened.

Historical D20 verification blockers (retained for chronology): D17 server source gates, the corrected local joint
two-Host/DSH cold case and full Manager integration pass. The first online run
passed actual TLS/WSS and control lifecycle but failed concurrent directory
refresh and cleanup at p2p.rate_limited. Its evidence remains failed. D20's
reviewed, fully tested server repair has since been deployed with port 8443,
identity and all twelve original user tables preserved; ordinary restart cleanup
retired only that disabled test scope's pending/expired control records. Client
transport, expired-auth-cycle and local-only logout ownership fixes passed focused
real local TLS/race tests and independent review. The next single cold diagnostic
nevertheless FAILED: both directory refreshes and peer connects were throttled
after transport connected. Actual bounded server samples identify certificate
query IP exhaustion and networks device-source exhaustion at the unchanged limit
of twenty. Remaining request amplification is under investigation; matching full
tests and a fresh online run are pending, not replaced by subset passes.
D18 implementation/component/Web
proof and D19's two native cleanup preflights pass; normal physical pause/crash,
eight-hour original-session and native UI gates remain open. There has been no
commit, push, tag or release. The default manifest remains unapproved. Earlier
failed scenarios below remain failures, not converted by later subset passes.

The independent runtime authority is implemented and its Windows native suite,
twenty concurrent fresh-open/ACL/publication rounds and focused independent
source review pass. A subsequent required manager integration command caught
a new race in diagnostics sampling during ICE initialization; preserve that
failed report and repair it before the next physical candidate. The runtime
authority does not explain or resolve the original overnight ICE loss.
The scoped UDP profile finished failed with source unchanged. Public Windows
firewall enforcement is disabled, so enabled rule readback is not proof of actual
packet loss. The user declined enabling that policy and requested process kill
instead. UDP acceptance remains open and must not be silently replaced with a
process-crash pass. Short cases additionally exposed a test teardown ordering
defect; its error is retained rather than waived as business success.
The subsequent one-case real process crash was injected and remains failed:
test core 10136 was killed/joined, core 5504 restarted with identical roots and
restored credentials, original DSH 30056 stayed alive, but the new supervisor had
no running record/binding. Natural retries reached connected and repeatedly
refused resume with p2p.runtime_unavailable. The first 25s deadline had already
failed during old-transport loss/grace detection; it is not solely attributed to
the missing binding. Its 45s observation, exact-handle cleanup and unchanged
source identity are retained in core-crash-20261019/. No runtime adoption fix or
overnight-cause acceptance is claimed. All task-owned captures have stopped and
the monitoring heartbeat remains paused with no following live run.
The eight-hour candidate was stopped through its existing test-only finish
operation at the user's request to prioritize fault injection. It retained about
fifty minutes of original-session idle and remains incomplete, not passed. Its
forward pressure case had already failed cycle eight. Controlled shutdown has
its own timestamped sidecar and must not be attributed to the original ICE cause.
The first-cause preflight also failed: two forward recovery cycles completed,
then the third ICE attempt had no selected path within the unchanged 25s recovery
budget and ended its 30s establishment window. The independent duplex case
opened Mac-to-Windows but failed Windows-to-Mac establishment before idle began.
Both sides' lease renewals succeeded during the scoped failure; the underlying
reason for missing ICE selection is still unconfirmed. New failures are retained
in `first-cause-preflight-20261019-1410/`, not overwritten by later recovery.
Its current-version duplex case passed 300 seconds of genuine application idle
in each direction, original HTTP cookie/session and original WebSocket readback,
then bidirectional recovery, temporary runtime refusal/recovery and stopped
runtimes staying stopped. This is not overnight, installed-app UI or Mac core
periodic-loop acceptance. The independent forward-stress case failed its first
explicit connection at ICE nomination, before any of its ten recovery cycles.
An exact-failure snapshot found the Mac source socket, active interface, route
and ARP entry present despite UDP writes reporting `sendto: no route to host`;
the OS-level reason remains unconfirmed. Retained earlier failures and the
unchanged 25s recovery criterion are not superseded by the passing duplex case.
Both peers' packet captures were collected; the owned captures/watchers have
stopped without changing firewall, adapter or installed client state. See the
Agent Note and `physical-idle/` raw evidence; do not mark 3.1–3.3 complete from
passing subsets. Parent/global framework and documentation gates also retain
their pre-existing blocking errors.

Latest runtime-owner physical case (`core-crash-runtime-owner-20261019-v0191/`)
proved the independent Windows DSH child, owner epoch, binding and console cursor
survived the test core's restart, but failed the unchanged 25s business deadline.
The surviving peer waited through 20s grace plus 4.230s until its periodic scan,
then needed 0.992s to reconnect, excluding earlier detection latency. This is not
an overnight cause or acceptance pass. All test processes were joined and the
original installed Mac/Windows processes remained unchanged. Section 4 addresses
the confirmed destructive/recovery scheduling and uncertain-decision defects;
it does not retroactively relabel this or earlier failed evidence as passed.

Latest CI follow-up (2026-10-20): app Quality run `39371808773` failed in the
Linux real-process certificate suite because its CLI fixture had no enabled
catalog service (`p2p.not_enabled` / `p2p.service_unconfigured`) and one lifecycle
maintenance request ran inside the coordinator's existing per-source budget
window (`p2p.rate_limited`). Test-only fixture setup now enables the exact
coordinator service and spaces the independent maintenance assertion with the
existing request-budget helper. These edits have not passed a new CI run yet.
The matching Package run `39371808799` passed for the preceding source SHA; it
does not cover these edits. Server CI `39371618100` reached the Go package's
implicit 10-minute test timeout after 77 coordinator tests passed; the manifest
now gives the full race suite a 15-minute test deadline and the Linux job 20
minutes. The rerun, server deployment, 8-hour physical profile, crash/pause
profiles and stable release remain pending; no release is claimed.
