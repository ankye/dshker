# Physical recovery verification, 2026-10-20

The user confirmed the bounded Mac capture and explicitly has no separate macOS
desktop account, test Mac or VM. Native desktop UI acceptance remains incomplete;
this does not authorize a second Mac instance sharing the original Keychain,
replacement of the installed app, or waiver of that gate.

Before any new fault, root read back the current workbench source digest as
`8cf38342afe96f49c6c9e6948668e41f0f76e029d8e42bbde9be5067d37fc3f4`.
Existing matching full20, full TS, cold, mixed Manager and same-Mac online proofs
remain separate prerequisites, not physical recovery or eight-hour acceptance.
No source edit is admitted during the physical run. The old heartbeat is paused.

The Mac capture was independently verified as PID 49046, user a1021500932,
started 2026-10-20 07:47:51 local, exact tcpdump command with interface feth1266,
snaplen 192, C=20/W=4 and the requested Windows MAC filter. Its output prefix is
the ignored `d20-physical-20261020.pcap`; pcap0 exists and decoded correctly with
actual IPv4 and IPv6 packets. This verifies active bounded capture, not business
health or recovery. Do not replace or truncate the user-started capture.

Mac original Launcher/core/DSH PIDs 46491/46515/47886 retained their original
parent and start identities on readback. Windows originals 46452/46508/45556,
explicit runtime hashes and capture ownership must be rechecked before faults.
No system network, firewall, power policy, original app, credentials, roots,
processes, or online coordinator may be changed by these isolated profiles.

The planned first gate uses a new d23-program-pause-20261020 evidence directory
and the existing runner's three approved profiles: 3s, 35s and five 3s pulses.
Each copied candidate must first pass the two independent cleanup preflights.
Both application directions retain the unchanged 25s release-to-readback budget.
This is program-unresponsiveness proof, not UDP-loss or native-UI proof. Exact
crash/restart and the real 28800s original-session idle plus ten recovery rounds
remain later independent gates. Preserve all failures and do not rerun unchanged
or manufacture recovery by reopening a tab or restarting DSH.

## First D23 physical attempt: input failure, not recovery acceptance

The fresh runner 06a7608a-406a-41ae-a507-6f8e40e34176 (PID 72687) ran from
2026-10-20T00:00:08.570Z to 00:01:39.929Z. All three independent program-pause
cases ended FAIL before a business fault could start. Each case first passed
both native pause-cleanup preflights; these six preflight passes are not recovery
passes. All nine raw-log hashes were independently checked against the final
proof; its SHA-256 is
`6cdf31eeea5af1cfe53ea926d9b7a330b8b94bd0f7138bae3add525131580390`.
The runner exited 1, all original logs remain under
`.run/open-workbench-recovery/d23-program-pause-20261020/`, and the source digest
remained exactly the frozen 8cf38342 identity. No eight-hour scenario started.

Windows reported `runtime.child_crashed` / `ERR_MODULE_NOT_FOUND` for
`@deepseek-ai/dsh-app-boot`. Read-only follow-up established that both the direct
package and compiled entry exist, but traversal through its installed dependency
Junction is denied by Windows with `0x800701C0` (untrusted mount point). The
explicit CLI hash is unchanged. There is no evidence of dependency deletion or
of a new Windows trust restriction. The October 19 note already records this
same installed-root failure and a successfully relinked isolated Temp copy;
root mistakenly selected the installed root for this attempt.
No Junction, ACL, installed version, system policy or original process was
modified. The only installed version cannot presently supply a fresh DSH start.

Windows PktMon was verified stopped with no filters; it was not started for this
already-failed input profile. The user-started bounded Mac capture remained
running, and a fresh snapshot was copied into the failed attempt directory.
The existing explicitly named test Harness copy was then located and checked:
`%TEMP%/dshker-harness-relinked-1a1524344bd` (the evidence retains its exact path).
Its CLI hash matches the expected `f9f0f132...3362`, direct and Junction boot
entries match, and module resolution points into that same test root. Its
declared Windows native prebuild exists (343,552 bytes, SHA-256
`ead441d11202126827a789a7eb88e79abe8f7f374b16e7273c4244225c8d6c2b`).
The incomplete earlier installation copy is excluded. No new copy, package
installation, link change, or hidden root substitution was performed. This is
input admission only; the next attempt must use that verified root explicitly
and a fresh evidence directory. A failed attempt must not be overwritten or
relabeled green.

Independent review verified the final proof, nine raw logs and three candidate
binary hashes. All three failed Windows runtime children reported reaped.
The Mac raw logs record only interrupt, not complete process-cleanup receipts;
a subsequent independent PID readback found the three logged test runtimes
73420/74321/75449 absent and the protected original Launcher/core/DSH identities
unchanged. This is not proof that every possible temporary descendant vanished.

## Correct fixture, second attempt: initialization conflicts

The fresh runner a53f9167-a6ad-44a1-a7ee-8607b62b2ed5 (PID 87711) used the
explicit verified relinked fixture from 00:21:28.197Z to 00:23:30.198Z. Both real
DSH runtimes started and reverse application readback succeeded. All three
business cases nevertheless failed before program-pause injection. Short/flap
submitted generation one after the production automatic outbound already owned
a newer epoch, yielding `p2p.stale_generation`; long reached the subsequent
second `core.catalog_enable`, correctly refused as `p2p.catalog_exists`.

The final FAIL proof SHA-256 is
`8d28e56bba1b622810663a61d0073e4cfc868f131a44fb8bf84346151f8046fc`.
All nine raw hashes were checked independently; source remained frozen 8cf38342.
The Mac snapshot SHA-256 is
`26f32c9060f505a5dda2dbf63fc6edd913d29822c3d8779a0d09d07e5fd6fa31`.
The source freeze may end only after failure evidence is preserved, never by
relabeling this attempt or automatically rerunning unchanged.

Windows bounded capture began at 00:22:32.635839Z, after the short case had
failed. It uses only ZeroTier component 16, empty filters, snaplen 192 and a 64 MB
ring under the exact task-owned dshker-d23-physical-20261020 ETL path. No filter,
firewall or network policy changed; other traffic on that virtual NIC can exist.
It cannot prove coverage before its actual start. The first capture operator
failed its pre-start admission because PowerShell's CP936 decoding corrupted
native UTF-8 text. Its script/FAIL receipt remain. A separate operator set UTF-8
only in its own child process, then passed the same exact capture guards and
started it. Collection must independently verify ownership again before stop.

Read-only investigation traced the unique initial catalog enable to the shared
initializer and the duplicate enable to the recovery test helper. Raw initiated
attempts precede the fixed-generation business request. Inbound generations are
separate and do not explain it. The production engine remains single-owned; raw
evidence cannot distinguish its ticker from its WSS Wake for the first attempt.
D24 records the test-only initialization repair and deterministic regression
gate. No production quota, timeout, automatic-recovery path or server change is
authorized by this test-driver correction; overnight ICE causality remains open.

Windows capture ownership was independently rechecked before the single stop at
00:32:25.6281259Z. Conversion ran once: 8,450 captured/formatted packets, zero
dropped events. Original remote ETL was retained; local ETL and pcapng copies
under this attempt's packet-evidence/Windows directory have equal remote/local
sizes and SHA-256s: ETL 964,357 bytes,
`2fa8a57d45424895507fff55e4fe39b575e242c7e6d8bcf5a5d44545da02b651`;
pcapng 1,360,464 bytes,
`c013659e3f393b8ced0e39edecc7970595b7817314c274befa62aeea00750a61`.
Preservation receipt SHA-256:
`6ca4f8ee322d8aaa5e3c95dcc626929934e75ed74e1980f79302b34af418f9a2`.
Final Windows capture status is stopped with no filters. No unrelated capture or
filter was changed. The bounded Mac capture remains available for later tests.

The three second-attempt logged Mac runtimes 87936/88524/88723 were independently
read back absent, while original Launcher/core/DSH start/parent identities remain
unchanged. After final FAIL/raw/packet preservation with source still 8cf38342,
root explicitly ended that source freeze and assigned only the D24 integration
test initialization repair. New physical runs require a new frozen identity;
none is running now and no eight-hour interval has begun.

The read-only baseline comparison at 00:43:07Z independently verified all 411
Go/module entries (including 162 production Go), five configuration hashes, ten
built artifacts and the server's 37 production Go/two modules/three local binaries
equal their saved baselines. Receipt SHA-256:
`d2fa76b431078f4cdc208966e77f80e32b383be78307ac9e69c713efe9e6cba6`.
This snapshot preceded D24's test-code writes. The old 238-file TS/Electron graph
has no historical source-byte hashes, so the receipt explicitly does not prove
all production source unchanged or infer it from built output.

D24 investigation subsequently checked actual argv: recoveryCore delegates to
the same owned `serve` launcher as every Windows physical profile. Helper names
do not establish a parent-driven mode. All applicable initial-open paths use
the real serve automatic owner; no unused alternate fixture branch is needed.
The crash profile intentionally opens only the surviving Mac's workbench and
must not gain a new Windows outbound workbench intent. Mac remains the separately
declared production Engine/Manager composition, not full Mac serve/native UI.

D24's first focused run failed compilation because the new closure was missing
an errors import; no test ran. That FAIL report remains in its own directory.
After the explicit import fix, seven top-level and 44 subtests passed under race,
vet passed, and all 412 Go/module entries were stable during execution. The
first static manifest attempt incorrectly classified the new local-only bootstrap
unit as live evidence; removing that false classification retains its unit tests
and all live acceptance gates. The next static scan also caught two new live
comments using its forbidden word, not a substituted runtime. A separately
proved comment-only wording change did not alter code/name/composition; another
fresh 51-test/vet run passed. Static verification then passed with 172 tests,
11 commands and three interaction workflows; size measured 299 files, zero fails.
These are not real program-pause passes.

Independent review found one remaining D24 setup issue: core-crash skipped the
completed transport/catalog barrier before reverse-open. Root accepted the
minimal shared-preparation fix with a pure phase-routing regression, preserving
zero Windows business opens in that single surviving-client crash profile.
The implementation task remains open until that correction is independently
rechecked. No production failure is inferred from this test setup finding.

Full TS validation also includes two real native-store migration tests. A
temporary data root does not isolate macOS Keychain. Static literal/source
analysis derives only 19 exact test keys in the 0def8197fda5 credential/enrollment/
session families. Metadata-only queries (no value access) proved all 19 absent
with authoritative exit 44; receipt SHA-256:
`ba4287c767c2b7b8b0cde21b6f97c9818cddfe261df94ef291d98261db114ecd`.
Root permits only these proven-absent test records, not original credentials;
the prepared source-gate operator must repeat absence before and after the full
unskipped suite, fail on any provider error/present value, and never delete a
residual automatically. This does not authorize a real second desktop instance
or waive the unavailable native UI environment. No source gate ran during this
preparation; execution still requires a final frozen identity.

The D24 P2 correction now uses the actual shared preparation in cross: every
Windows serve phase waits for exact completed automatic transport and reads its
catalog before reverse-open. Core-crash issues no Windows business connect or
entry; forward stress has no reverse. The new routing/negative regressions passed
with the full bootstrap matrix: nine top-level plus 53 subtests, 62 named PASS,
zero fail/skip/race, vet PASS and 412 Go/module entries equal before/after. Raw
proof is d24-bootstrap-all-phases-20261020; previous 51-test passes and failures
remain separate. Independent review closed P2 with no new discrete blocker.
Three final test-source SHA-256s/line counts:

- core: `a7713f139186943379d8b76a78ac0257e087d1de67647f34e68eb8004900cc03`, 509.
- cross: `0cc1650a3d122aa6f8ac049fac778fe91b63350f4b740f43a420b817b8291560`, 814.
- bootstrap: `33e13a2f0eab83b965167ed059b51a0e01bd1564b7e0aaf8deda71c880ef26f5`, 472.

The updated static integrity gate passes 172 tests/11 real commands and three
interaction workflows; the size gate measures 299 changed code files, zero
violations. Task 4.17 closes only this setup repair (16/38), not any physical,
long-duration, native UI or release task. No new physical acceptance is claimed.

Root then globally froze code/manifest identity as
`5cb2d39092ec588a0803ccf597b7b1d1bc0610066ceb674b69ca9ab300d0425d`.
The D24 source operator retained that exact identity before/after every command
and across 978 code/manifest files and 238 production-graph source hashes. Its
first eleven commands passed: the core source build, all 1,868 TS tests in 426
suites (zero failure/pending/todo), environment, format, architecture, types,
service/static-visual smokes, renderer/Electron source builds and core dependency
listing. All 19 native test keys were absent both before and after TS. The final
parent validator alone failed on the machine-specific path originally written
in this note. That failed summary remains unchanged (SHA-256
`4b3645457c384b5c7456b4f15b5e484f33f00430ad7e2b33993e58c30b5ad4a1`).
Root corrected only the prose path to portable TEMP notation and recorded this
failure; no code/manifest changed. A fresh separately recorded parent-validator
continuation is required. Do not rewrite the original summary as green or rerun
the already passed suite as an unchanged automatic retry. These source gates do
not prove physical/native UI or installer acceptance.

### D24 physical program-pause failure retained

The separately recorded parent-validator continuation passed after the prose-only
path correction (summary SHA-256
`71ba9de877141e6da5ec2ee9833bdeab6acc22e31b4089fd6080616e6bce583e`).
The first source-operator failure remains unchanged, not relabelled as a pass.

The fresh D24 physical runner `b0f56972-27f3-4465-8126-ab4c4b675abf`
started at 01:10:41.181Z and ended at 01:14:39.833Z on 2026-10-20 with exit 1.
Its final proof, `.run/open-workbench-recovery/d24-program-pause-20261020/physical-verification.json`,
has SHA-256 `cce1a9805ab8e3322814c5d28e5a958cdcc2afd6f19f2a5b4b92a71e13a959d0`.
All nine raw-log hashes matched; source identity remained exactly `5cb2d390…0425d`.
The 3-second pause and five short pulses passed their original-session readbacks
in 704ms and 750ms respectively. The independently completed 35-second pause
failed the unchanged 25-second release-to-both-directions readback budget, so
the aggregate is false. No crash or new eight-hour acceptance has started.

The long-case pause guard verified the same owned Windows core, exactly 35,000ms
held and successful release/cleanup. Forward recovered quickly; reverse did not
create its successful answer-side candidate until about 30 seconds later. Both
reviewers used same-machine timelines because the two wall clocks differ by
about 8.3 seconds. Mac's failed replacement remained ICE `new` for 30.003s;
its following successful candidate entered checking and connected in about
230ms. This locates the delay before effective ICE negotiation, but does not
prove where the previous Prepared/offer was lost: the old logs lack admission
and rejection receipts. Candidate-slot cleanup is a concrete source-level
suspect requiring a deterministic failing test, not an established overnight
root cause. Unrelated-interface no-route warnings are not selected-path proof.

Bounded Mac snapshot SHA-256 is
`ccac8f3418e46c7208d06608f158950d0b9eef4006fe7290a39f2ad67f7627a9`.
The exact owned Windows capture was stopped once and converted once; original
ETL remains remote. Its ETL and pcapng copies are respectively 2,194,284 and
3,168,196 bytes, SHA-256
`da8364bb489e2de5eb7ac75200f2ed7d5f929b424edd6198f44b8d2de4db0fb2` and
`6c8302cb0aed68fd41e0844bff966ce0092affee29f12fc60e477568cc0d4121`.
PktMon reported no lost events, conversion 19,995 packets and zero drops;
final capture stopped and filters empty. These are bounded virtual-NIC packet
receipts, not full payload or business-pass evidence. Preservation receipt SHA
is `0dc769f8cdcb8a184df447f019c24454e74ed1855f17711f0e90203111a6a17f`.

After preserving the failed run, packet copies and unchanged-source receipt,
root explicitly ends the `5cb2d390…0425d` freeze for deterministic regression
work and evidence-supported repair. Never rerun the same source to obtain green
or overwrite this failure. Protected original applications, user credentials,
network/firewall settings and deployed server are unchanged. Native desktop
UI acceptance is still open: the user has no independent Mac desktop account,
test Mac or VM; it is not waived by source or physical headless proofs.

### D25 deterministic admission regression and repair scope

Before production edits, the new two-top-level/six-subtest regression failed
all eight named tests at the actual retained-successor boundary, not fixture
setup. Real local TLS, signed tickets/SDP and Pion transports are used; the
existing subscription adapter supplies ordered events, so this is neither full
coordinator WSS nor physical proof. The original RED file remains frozen at
SHA-256 `c0a4aaf8705cc48f05159d393581533d5df5a2bd86a285394c8eeccce315c243`.
Raw evidence is `.run/open-workbench-recovery/d25-inbound-retirement-red-20261020/raw.jsonl`,
SHA-256 `0d53f52b59c7779d80e18766d22235e1eba681fdd62142d0ca2a4a0a78473f88`.
It has zero skips/races; all 413 Go/module files matched before/after. The
confirmed code defect does not retroactively prove the unlogged physical event.

The D25 plan explicitly introduces only one typed, joinable pending-admission
owner per pair, holding the immutable new ticket and existing one-entry inbox.
It has no transport/runtime authority until exact old-ticket State permits the
existing promotion/retirement barrier. Valid current terminal events can retire
the exact reservation synchronously; transport and End cleanup remain owned and
joinable. No ticket-generation inference, generic mailbox, replay, fallback,
deadline extension, new authentication, schema, wire or IPC is authorized.
Existing deployed D20 server supports the required exact State; it is unchanged.
Full account/pin/network/subscription lifetime checks and credential-free bounded
Prepared/offer/answer/decision receipts are part of this repair, not optional
later hardening. Negative scope/unknown-state tests and independent review must
precede another physical profile. All earlier failed evidence remains intact.

D25's initial committed-startup regression reproduced four named failures with
the real held-TURN cleanup and TLS End path: a successor arriving during old
cleanup was rejected, and the same promoted primary's duplicate Prepared could
create a second owner. The original RED evidence is
`.run/open-workbench-recovery/d25-inbound-committed-startup-red-20261020/summary.json`.
The repair keeps the exact terminal retirement result in a caller-owned typed
receipt across old cleanup; it does not infer retirement later from the
Manager's mutable retiring map. The independent review found and closed that
cleanup race before final GREEN. The sealed joint D25 run
`.run/open-workbench-recovery/d25-inbound-racefix-green-20261020/summary.json`
passed 93 named tests across 21 top-level tests with zero failures, skips or
data races, and unchanged source identities. It includes 8 retirement, 17
admission-boundary, 3 wake, 7 publication, 5 committed-startup and 53
credential-free diagnostics assertions. Final source SHA-256:
`ca40efbb60fa6afd28744717e1ff4835bf11ca7adabd045cb88a1ca5cdb575cc`; final raw
SHA-256 `3b5a537b4f1e981d5b3f5a93dde70b46f9c916e18b97c255eefcc6494495425c`.
This is focused Go proof only: D25 physical pause, core-crash, a fresh 28,800
second original-session idle run and post-idle recovery, full final Go/TS/source
gates, CI packages and installed UI validation have not yet passed. Earlier
failed physical evidence is unchanged and remains failed.

The first final twenty-package Go race attempt was preserved at
`.run/open-workbench-recovery/d25-client-gates-20261020/summary.json` (exit 1,
1,585 pass, 1 fail, 0 skip). Its only failure was the pre-existing revocation
test constructing a reserved `session` without its required `PairID`, so the
real pair-scoped cancellation correctly did not match the malformed fixture.
The fixture now sets its pair identity explicitly; production code is
unchanged by this correction. All 18 exact stress-test Keychain keys were
authoritatively absent before that run and the exact test-owned values were
removed and verified absent afterwards.

An earlier final-gate snapshot was
`93b3404bf703cfc6a2d0c0e52410e5b87e301db6af848ac6d93447a886b6b8dd`. On that
identity, the twenty-package Go race/vet operator passed 688 top-level plus 898
subtest passes, with no failures, skips or races, unchanged 420 Go/module source
files, and verified absence before/after of all 18 exact stress-test Keychain
keys. Receipt: `.run/open-workbench-recovery/d25-client-gates-final2-20261020/summary.json`,
SHA-256 `cf960a82b43b7b03511c2d7c7013c264eb5ec60ed3dbab9f09e536038a981ae6`.
The full desktop source operator passed all 1,868 TS tests across 426 suites,
environment, format, architecture, types, service and visual smokes,
renderer/Electron builds, core dependency admission and the parent workspace
validator, with the same digest before and after. Receipt:
`.run/open-workbench-recovery/d25-source-gates-final3-20261020/summary.json`,
SHA-256 `ccfffbc9d8f54ddb6872924513f451411a124a960a257ed8b09cdd697ceb0196`.
At that snapshot, all 44 evidence paths then listed in the test-gate manifest
were checked to exist.
One earlier source run's Prettier-only failure remains preserved at
`d25-source-gates-final-20261020/`; final formatting and all remaining gates
pass. Physical pause/crash/8-hour, CI package and user-installed UI acceptance
remain pending and are not claimed as passed.

The test manifest then added explicit links for the last exact-source receipts;
no product source changed. The final frozen digest is
`9bd54c385f02759d6de6673c62321518e3dc53ae25dcce9738757830576a3012`. On this
identity, the full twenty-package Go race/vet operator again passed 688
top-level plus 898 subtest passes, zero failures/skips/races and unchanged 420
Go/module files; all 18 exact Keychain test keys were absent before and after.
Receipt `.run/open-workbench-recovery/d25-client-gates-final4-20261020/summary.json`,
SHA-256 `03b1fcd38f38eced9dad1115d281f05ec0bb1e423a17b6bbd909936fc0823fb4`.
The full desktop-source gate on this same digest passed all 1,868 TypeScript
tests, 426 suites, all source/build checks and parent validation. Receipt
`.run/open-workbench-recovery/d25-source-gates-final4-20261020/summary.json`,
SHA-256 `a3589ed5d29641fccaf9ed49734f1388984ec9196254b8a854d70a321c54ac71`.
All 47 final test-gate evidence paths exist. The 28,800-second physical idle,
post-idle recovery, physical pause/crash and installed UI are still pending.
