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

Publication sequencing exception (2026-10-20): after being informed that the
long-duration gate is incomplete, the user explicitly requested direct stable
publication. Publish the current production candidate through the unchanged
GitHub tag/package workflow, with outstanding ICE, eight-hour/native and macOS
packaging limitations stated in both Release languages. This changes publication
order only: no failed or incomplete task below becomes passed, and the full
recovery objective remains open. Do not ship the ignored D32/D33 overlays or
claim the diagnostic build is a production fix.

Publication/install continuation (2026-10-21): the user explicitly authorized
packaging these two scoped fixes, updating the local Windows installation, and
committing/pushing/tagging/publishing version 0.1.94 after the remote tag was
confirmed unused. Preserve device/account/network/pair data and record the exact
installed artifact and readback. Keep the prior incomplete broad and physical
gates visible; this authorization does not turn them into passes or waive the
tag workflow's own quality, native-package and asset validation.

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
- [ ] 4.21 Client/QA/reviewer: preserve D26's explicitly refused optional-workbench transport through durable promotion, exact old-mux detachment and suspension/recovery without false readiness; retain unexplained-binding and HTTP/WS failures. Correct independently stale CI method-table, current-user, catalog and target-device inputs; prove focused races and real coordinator/core regressions before treating the peer suite as green.
- [ ] 4.22 Release/QA/reviewer: let packaged smoke exclusively own its exit after success evidence or failure diagnostics finish, even when the probe window is the last Windows window; refuse diagnostic-write failure with exit 1. Prove normal close/tray behavior unchanged and confirm the final Windows ARM64 package in CI without weakening renderer checks.
- [x] 4.23 Client/root/reviewer: remove D27's legacy global terminal-reset shell operation and ordinary catalog/resume callers; preserve transient RetryNow and exact epoch-fenced durable Reauthorize only. Prove real shell/core admission, service A/B isolation, late old-scope results and unchanged retry budgets before freezing physical candidates. Focused races and 1,893 desktop source tests passed; independent review closed the historical Entry fixture race without relaxing ready admission. Physical acceptance is still separate under 4.19.
- [x] 4.24 QA/root/reviewer: after sealing the D27 physical aggregate FAIL, correct the Windows test receipt reader's first-open sharing contract and observe exact orphan-runner early exit. Prove real DELETE-handle red/green, strict invalid receipt refusal and immediate named-stage failure without retries, budget changes or production edits; independently review before freezing and repeating the unchanged native preflights plus short/long/flap profiles. Native Windows 22 helper cases and Mac 32 pure cases passed; cleanup, compilation and independent review passed. These complete the helper repair only: historical 454ms/828ms subset passes remain distinct from the failed aggregate and still-pending fresh physical/crash/8h/native acceptance.
- [x] 4.25 Client/root/reviewer: implement D29's exact predecessor grace gate before either endpoint publishes Ready, keeping the existing early observer and renew owner alive; close the coalesced-recovery notification race, recheck before commit dispatch and retain durable committed authority. The complete peersession/peer/runtimebridge race suites and vet passed after independent review closed incomplete-committed-broadcast and Stage-to-reservation recovery races. Actual local Pion HTTP and the original WS survive cancellation; grace, lease and business deadlines remain unchanged. This completes deterministic/source repair only: physical 25s, short-profile zero-attempt/resume, crash, idle and native acceptance remain separate under 4.19.
- [x] 4.26 Server/client/QA: implement D30's bounded shutdown-stage and bootstrap/stream termination diagnostics, consume exact stop errors and fail before post-stop database mutation. The independent server's deterministic raw-connection/cancellation/final-flush barriers, focused races, exact-SHA full CI and production smoke passed at `9665b122`. Its verified Linux artifact is deployed with identity/state/8443 preserved, followed by separate trusted-TLS/owner readback and an actual mTLS WSS/v2/same-Mac two-Host DSH gate. The deploy operator's transient listener-parser failure remains retained; successful readback did not replay the switch. This closes the scoped source/CI repair, not a universal whole-process 5s guarantee, physical ICE cause or release acceptance.

- [x] 4.27 QA/root/reviewer: implement D32's diagnostic-only app-owned Go overlay after sealing D31. Ten Go pure/real-UDP race cases, eight Node collector cases, actual local two-Pion DTLS and independent review passed; the original legacy-ID collector guard failure remains with a distinct read-only continuation, not a network rerun. The sole physical diagnostic finished FAIL (short/long failed before injection, flap passed). Its first short attempt has complete zero-drop socket evidence at both endpoints; cleanup successor logs are incomplete and never counted as full-case proof. All overlay/operator/capture hashes are retained. Production transport, pinned modules, interface choice, deadlines and release gates remain unchanged.

- [ ] 4.28 QA/root/reviewer: implement and test D33's separate ignored read-only exact-socket receive-queue overlay, explicitly distinguish Darwin head-datagram length/count/capacity from unknown/unsupported states, join its bounded sampler, independently review and freeze the new identity before one physical diagnostic. Preserve D32's failed and incomplete evidence. Do not infer privacy denial/netpoll cause from interface receipt or a single queue sample; production, eight-hour and native gates remain open.

Latest D32 result: the same Mac socket read stayed pending for 26.208 seconds
while its interface captured 133 valid complete requests; two earlier admitted
nomination responses returned a real errno65 write failure. This is a precise
socket-delivery boundary, not a confirmed OS/privacy/netpoll cause. No early
socket close or read error occurred before cleanup. The coordinator is now
deployed and its actual online control/DSH gate passes, but no physical aggregate,
eight-hour original-session, final native interaction or release gate passes.
Mac native continuation awaits manual unlock; no policy or permission was changed.

Current D31 verification: exact client `4848983` Quality/Package and independent
server `9665b122` CI all passed, as did six local joint integration groups (eight
named cases including subtests). The single physical program run remains FAIL:
short 3s and long 35s recovery passed in 766ms and 1000ms, while flap failed initial
ICE before injection. All six native safety preflights passed. The original WS
survived only the short case; the long case used automatic replacement. Failure
evidence and both captures are sealed; no eight-hour run, core-crash acceptance,
final native ledger, server deployment or release has completed on this snapshot.
D32 observation is diagnostic-only and cannot certify a production candidate.

Earlier D29/D30 verification: D29's complete local peer/session/bridge race suites,
vet and independent source review pass, including exact committed admission,
coalesced recovery and the actual Engine-to-reservation race. D30's initial and
program failure observers, bounded stream diagnostics and platform-specific
process-stop tests have passing focused source evidence. The fresh desktop/source
operator passed all nine commands, including 1,893 tests with zero failed/pending
cases and renderer/Electron source builds; the separate parent app validator
also passed. D30's
independent coordinator shutdown-owner repair and final joint CI remain pending.
Neither these local tests nor the earlier
native sign-in/reopen diagnostic prove physical pause/crash, eight-hour original
sessions or final installed-app acceptance. D28's aggregate remains FAIL, all
original packet/process evidence remains retained, and no release is published.

Historical D24 verification: source 5cb2d390 passed the fresh source/TS gates (with
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
existing request-budget helper. The matching Package run `39371808799` passed
for the preceding source SHA; it does not cover these edits. Follow-up commits
`f346959` (server CI timeout) and
`6c260f5` (client fixture corrections) are pushed. Client Quality run
`39375357657` confirmed the lifecycle test now passes, but the new Linux CLI
recovery test still hit the unchanged source-IP budget on its final real
certificate readback (`p2p.rate_limited`). A second test-only budget boundary is
added before that independent readback; it has not passed CI yet. Server run
`39375336585` is in progress. Server deployment, the 8-hour physical profile,
crash/pause profiles and stable release remain pending; no release is claimed.

Latest D26 follow-up (2026-10-20): Quality run `39376523526` exposed one real
optional-workbench regression: an explicit runtime refusal was discarded and
its missing gateway then closed the established device transport. D26 retains
that refusal and transport without claiming ready, detaches the exact old mux,
and verifies a later ready workbench through the same browser entry. Local
focused races passed 69 cases including the initiated ready/refusal/ready path;
the full peersession/runtimebridge/autoconnect race suites passed. Independent
CLI/current-user/catalog/method-table fixture corrections still need CI's
isolated credential environment; they were not run against the shared Mac
Keychain. Direct real-coordinator two-peer tests passed both-direction and
reverse-reconnect cases; this does not replace the failed historical physical
pause profile or the incomplete eight-hour test.

Package run `39376523547` also exposed a smoke exit race, not an observed P2P or
renderer crash: Windows destroyed its sole probe window before writing its
result, so window-all-closed quit prematurely. The smoke exit owner and explicit
failure exit are repaired, with red/green lifecycle tests including unwritable
payload and trace paths. Native Windows ARM64 package confirmation remains
pending. The independent server's installed binary was read back and matched
the frozen artifact SHA and current runtime build inputs; its dirty build VCS
label alone was not evidence of an outdated deployment. Server CI
`39375336585` passed. No tag or stable release has been published for D26 yet.

Continuation: Quality `39392280651` passed Linux desktop verification but Windows
exposed a test-only native filesystem error-shape assumption in smoke lifecycle.
Its exact-operation oracle is corrected without weakening exit/error ownership;
final native CI is pending. The user explicitly closed the original Mac app and
authorized candidate UI verification, preserving all original account, device,
network and pairing records. Native interaction proof must now be collected from
the actual candidate rather than substituted from headless or smoke results.

## 5. Login-driven network convergence

- [x] After confirmed login/registration, start the same current-user synchronization automatically while keeping the signed-in identity immediate in the UI.
- [x] On each exact confirmed current-user session, repair a displaced coordinator WSS subscription and idempotently adopt the device's existing authorized network memberships.
- [x] After adoption, have the independent coordinator publish the source device's authenticated registration to currently online devices authorized on a shared network.
- [x] On recipients, validate the account/session, refresh the peer catalog and device directory, and notify active renderer network-choice views without changing saved selections.
- [x] Verify client, server, and renderer state transitions with focused and full local test gates; keep failures explicit and retain prior device/network/pair state. Vitest 1,896/1,896, Go client helper/peer-session race suites, the real local Gin/WSS/SQLite coordinator push integration, full independent server `go test -race ./...`, server vet, client/server source-size gates, app test-integrity default verify, OpenSpec strict validation, desktop-app validation and renderer/Electron builds passed. Physical Mac↔Windows and overnight ICE acceptance remain separate and are not claimed here.

## 6. Restore freshly authorized original network state

- [x] 6.1 Root/product: reconcile D18/D27/D35 with D36 and specify automatic recovery only for freshly active original service/account/network/device/key authority; update bilingual release/user guidance and Agent Note, then pass strict OpenSpec validation.
- [x] 6.2 Client: restore a locally revoked original choice through legal atomic catalog transitions under selected-session/registration fences, then recover only its durably authorized engine intent through the atomic current-stop whitelist. Every choice read publishes fresh pins through a CAS, including a no-op record after a lost reply; it does not select another network, change identity, mutate server pairs or start DSH.
- [x] 6.3 QA/reviewer: prove the revoked-row regression, repeat/restart readback, real revocation/alternate network/account/key refusal, failed reads/publication and terminal isolation with focused races and an isolated real coordinator/helper case. Final scoped races passed 89 named tests/subtests with zero failures/skips; real integration retained old-source failure and current-source success, default test-integrity passed for two production/five test files, six affected desktop suites passed 28 tests, and source-size/scoped formatting checks passed. Keep the broad checks in 6.4, installed-app, physical Mac↔Windows, overnight and release evidence separate.
- [x] 6.4 Root/QA: retain the original failures and resolve their causes before release. Short-lived certificates are now issued after fixture setup, preserving real expiry; the full helper race package passed in 188.444 seconds, beyond the old 180-second cutoff. Formatting now excludes the per-machine configuration; portable fixtures/examples clear all three parent-validator findings. Local desktop coverage passed 1,876 cases with the version-worktree fixture explicitly excluded; a prior npm forwarding mistake ran and cleaned that fixture and was disclosed. Complete Go coverage is one first run plus successful whole-package repairs for two existing Windows fixtures, not a single all-green invocation. Remote full CI and installed-app evidence remain separate release gates.

## 7. Keep Windows local startup in the background

- [x] 7.1 Root/product: add D37, its native-background-process contract, bilingual release/user guidance and Agent Note; pass strict OpenSpec validation while preserving the prior network recovery work and section 6.4's broad-check status.
- [x] 7.2 Runtime owner: apply Windows HideWindow/CREATE_NO_WINDOW to the supervised child and shared background command constructor used by port inspection and taskkill; preserve non-Windows exec/process-group behavior, pipes, logs, readiness, Stop and independent-owner lifetime without changing SSH flows.
- [x] 7.3 QA/reviewer: the complete harnessruntime race suite passed 56 named tests/subtests, native root/grandchild and standalone command probes produced five zero-console-HWND receipts with preserved output/exit/Stop behavior, and combined default test-integrity passed for seven declared test files. The original mistaken zero-process-count assertion remains failed evidence. Vet, five code-file size checks, native build and same-SHA five-observation headless smoke passed; the production dependency/binary probe-isolation scan and independent review passed. Darwin ARM64 test compilation passed without claiming a Mac runtime result. Installed-app, section 6.4's broad failures and physical ICE/release proof remain separate.

## 8. Authorized 0.1.94 packaging, local update and publication

- [x] 8.1 Release/docs: after confirming the remote version is unused, synchronize package and root lockfile versions to 0.1.94, record both fixes and known limitations in its bilingual CHANGELOG entry, and use that exact entry as the Release body. Root version identity, body extraction and bilingual-limit checks, scoped formatting, diff checks and strict OpenSpec validation passed.
- [x] 8.2 Release/root: the native Windows 0.1.94 package and installed application smoke pass. The authorized update moved the program to the selected D-drive Applications directory, with registry/shortcuts updated and the old program removed. Original roots, installation catalog and account/network/device/key identity are unchanged; normal startup restored the Mac record from revoked to active without reselection. A bounded 30-second observation found no new console windows; separate real CUI kernel probes remain the direct console-creation evidence. Five installed payload hashes match extraction from the verified public Release installer.
- [x] 8.3 Root: scoped source/tests/docs/version commit d5c767a4b83654d08bdc9deedfc70dd96e5e9446 was pushed to main; annotated v0.1.94 was created and pushed at that exact source. Generated outputs, credentials and local roots were excluded. Post-release evidence updates are documentation-only and do not move the immutable source tag.
- [x] 8.4 Release/root: same-source Quality 39573955095 and main Package 39573954959 passed; tag Package 39575392266 attempt two passed all six desktop and six CLI targets and publication. The first tag attempt's existing heartbeat-count fixture race is retained and independently explained, with no assertion/skip/gate/tag change. Public stable Release 419392063 carries 25 uploaded assets; eight desktop and six CLI binary digests, seven manifests, the downloaded Windows installer and the exact bilingual CHANGELOG body were verified. Release/local readback is recorded in the release Agent Note. Section 6.4's earlier failures remain historical; physical ICE, overnight, final cross-platform native-UI and signing limitations are not claimed complete.

## 9. Preserve an explicit Run-page connection behind background preparation

- [x] 9.1 Root/architecture: record D38 and its cancellation, scope, immutable-attempt and truthful projection contracts; add Agent Note and pass strict OpenSpec validation.
- [x] 9.2 Desktop owner: remove the two pre-connect background retry wakes; isolate refusal records per service/pair and close the accepted-reply/late-readback gap without another connect or invented Ready. Main publication rechecks operation/session/caller ownership and catalog revision at commit. Focused main/renderer regressions and independent review passed.
- [x] 9.3 Go owner: retain one fenced explicit waiting request behind a background candidate, revalidate and reserve its own generation after safe handoff, and reject cancellation/Disconnect/scope races. Initialize truthful pre-ticket state and bounded diagnostics; preserve sticky unknown prepare results while allowing only actual HTTP 429 and exact same-fence HTTP 404 non-admission to back off. Full internal/cmd race coverage and independent review passed.
- [ ] 9.4 QA/root: retain regression failures, pass race/state-identity tests and a real coordinator flow, verify source/artifact isolation, source-size, typed admission, formatting/types/build and default test-integrity. Exercise the actual public Run control and distinguish installed/physical outcomes from source tests.

## 10. Unify footer and account authentication

- [x] 10.1 Root/product: record D39, shared authentication semantics and current Mac observations; update user guidance and Agent Note, then pass strict validation.
- [x] 10.2 Desktop owner: use one selected-service account state for footer and account panel, including pending, signed out, signed in, invalidation and stale result fences. Keep transport status separate and visible copy typed. Historical identity does not grant write authority while current state is unknown; only confirmed sign-out offers credentials. Late reads cannot replace a newer login/logout. Independent review and regressions passed.
- [ ] 10.3 QA/root: verify shared presentation and account lifetime/service isolation, complete relevant source/build and default integrity gates, then exercise both surfaces in the real application. Preserve current successful installed 0.1.94 connectivity as an independent observation.

Source/Windows candidate evidence for 9.4 and 10.3: 5cd505d passed the final local
1,933-test desktop run and both exact-source CI workflows, including six native
and six CLI packages. Installed D-drive payloads match the staged candidate and
original identity/root records are unchanged. Public controls passed three shared
account-label observations and opened the original Mac workbench with loaded
guest content. Full default interactive verification still fails because actual
display refresh and pixel-frame coverage are unproven; retain these tasks as
incomplete. The user explicitly deferred updating the Mac installation; keep its
current installed version and processes unchanged.

## 11. Explicitly authorized 0.1.95 tag publication

- [x] 11.1 Root/release: following the user's explicit publication request, create and push annotated v0.1.95 at the exact validated and installed production source 5cd505dd41efa49f82fcf7ca0a3a29c3a12fb66a. Remote annotated object 60c32ce39eeb1c342ea3e9ec4fc675cca2e0a475 resolves to that source. Subsequent fd9d8db only changes diagnostic tests and evidence. Retain the failed native-frame gate and incomplete eight-hour verification; publication does not complete 9.4 or 10.3.
- [x] 11.2 Root/release: independently confirm public stable/latest Release 419657247 for v0.1.95 with all 25 assets uploaded. The annotated tag resolves to 5cd505d, its bilingual body exactly matches the tagged CHANGELOG, six desktop manifests retain the exact source/version, and GitHub's 14 binary SHA-256 digests match both checksum files and manifests. All target build/smoke/upload steps succeeded. The Actions API initially lagged behind publication; final readback confirms Package run 39614812762 completed successfully at 2026-10-21T14:30:31Z and its Publish job succeeded at 14:27:01Z. No installer was changed; the Mac remains on its existing version. Native-frame and eight-hour acceptance remain incomplete.


## 12. Formal-profile recovery and isolated test distributions

- [x] 12.1 Root: record D40, the user's explicit preservation/recovery/release authorization, the real released-binary reproduction and the separate current Mac evidence; keep older acceptance limitations unchanged.
- [ ] 12.2 Desktop/build: implement fail-closed test/stable profile selection before state access, distinct test installer/application identity, explicit independent test roots and complete native-home/bootstrap/catalog isolation; verify production-path exclusion and preserved formal defaults.
- [ ] 12.3 Core: contain owner admission refusal in both production compositions, preserve exact runtime errors and old owner evidence, and align graceful shutdown with its existing cleanup budgets; prove with real isolated compositions and focused races.
- [ ] 12.4 Root/QA: securely back up existing formal records, retire the unisolated test copy, perform the explicitly authorized abandoned-owner recovery and prove identity/catalog preservation. Through formal public controls verify login, existing SSH and original LAN/P2P workbench restoration and normal restart.
- [ ] 12.5 QA/reviewer: complete state/identity matrix, source-size/isolation, strict OpenSpec/default test-integrity, relevant full source/build gates and independent review. Preserve original failures and distinguish functional physical evidence from prior incomplete frame/eight-hour acceptance.
- [ ] 12.6 Root/release: freeze unused 0.1.96 source, build and update the formal Windows installation with verified package identity, verify the installed recovery again, push exact source/tag and publish verified native/CLI assets with bilingual notes. Mac installation is not updated unless separately authorized.
