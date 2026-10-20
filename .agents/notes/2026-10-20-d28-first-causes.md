# D28 physical failure retained; D29/D30 boundaries

The D28 program-pause aggregate at source digest
`bac6c49863eafd57078b80de78118337723231bb56cfacbfef32396c1fac5966`
and HEAD `702ca51` is FAIL, not a repeat of the repaired helper failure. All six
native safety preflights passed. Short failed before injection: the exact Windows
DSH child stayed starting for its original 30s with zero observed output. Long
failed before injection: initial ICE remained checking without a selected path
under its original 25s criterion. Flap completed five controlled pauses but its
original WS ended during candidate promotion. No crash or eight-hour acceptance
was run on that candidate.

Raw files, source before/after hashes, exact test-process cleanup and both packet
snapshots are sealed under `.run/open-workbench-recovery/d28-program-pause-20261020/`.
The owned Windows capture is stopped/converted, hashes read back and its exact
filter removed. The user's bounded Mac capture and native diagnostic Launcher,
core and runtime owner were not stopped or changed. The source freeze ended only
after that failure seal and cleanup. No automatic rerun-to-green occurred.

Independent read-only packet analysis found IPv4 STUN requests at the Mac
interface without corresponding responses for the affected long/forward flows;
the flap reverse IPv6 flow continued successful transactions. The forward flow
had already stopped responding in the second clear window, before the third
pause. Same-transaction alignment measured approximately 9.54–9.58s clock skew;
a separate SSH time observation bounded Windows-minus-Mac to [-9618,-8846]ms.
No clock, route, interface or firewall setting was modified. Interface receipt
does not prove kernel socket delivery or STUN MESSAGE-INTEGRITY admission; the
underlying ICE stall is still under investigation.

The flap business-layer retirement is proven independently: old attempt `9906…`
records `candidate_promoted` and WS EOF at Windows 09:53:44.9233638, followed by
owner-context cancellation about 0.515ms later. D29 therefore gates both endpoint
Ready publications on the exact old recovery owner, not merely source Commit or
post-commit promotion. The existing decision observer and capped lease worker
remain active; coalesced transport recovery must cancel the exact candidate.
Explicit core replacement and workbench upgrade are separate paths. Deterministic
regression and independent review remain required before another physical freeze.

Separately, Quality run `39403408877` failed the real-process certificate suite
at its coordinator stop guard; the peer suite was skipped. The fixture's whole
5s guard and the server's later separate 5s HTTP drain are incompatible at their
limits, but no stage receipt proves where this occurrence stalled. D30 adds
bounded lifecycle evidence and exact error ownership before claiming a fix.
Do not widen that guard, call this infrastructure flakiness, or merge it with the
physical Windows startup/ICE failures. Current stable release, eight-hour gate
and final native interaction acceptance remain pending.

## Stream diagnostic regression

The D30 supervisor receipt records only stdout/stderr, fixed EOF/closed/read-failed
reason, exact launch/PID and whether the launch's own Wait receipt has completed.
It does not infer OS liveness, emit arbitrary error text, change readiness, adopt
a process or retry. Final bytes are consumed before recording EOF. No IPC schema
or persisted launch format is changed.

The focused tests first failed with missing receipts. A deterministic concurrent
log-close/reader-EOF race test then exposed the existing unsynchronized log
pointer: closeLog wrote it while writeLog read under the record mutex. closeLog
now uses that same mutex, with no lifecycle/deadline change. This removes a proven
data race; it does not explain the D28 zero-output startup or underlying ICE stall.

## D29 source repair and independent review

Both endpoints now retain the exact old recovery owner before their first Ready.
The single existing transport observer cancels recovery candidates even if the
public projection never became suspended. The existing early decision observer
and renewal owner remain alive while waiting; closed context/transport/mux and
cancel/committed broadcasts cannot steal consumable transport events.

Independent review caught two additional admission gaps before acceptance: a
merely status-committed receipt could publish an irreversible wake before proving
both-ready and exact active attempt/generation; and Engine's suspended read could
race with recovery before reservation captured its intent. Deterministic red/green
tests now cover both. Background resume reserves the usable predecessor's recovery
intent even after that race; explicit workbench upgrades/core replacements retain
their distinct behavior. Four malformed committed negatives cannot release Ready.

Final complete local peersession/peer/runtimebridge race suites passed in
84.309s / 16.572s / 12.491s; vet and the 11-file size gate passed. The same reviewer
closed both findings and reread six frozen production-file SHA values. Actual
local Pion HTTP and the same original WebSocket survive the production candidate
run/cancel/cleanup path. This is not a physical Mac/Windows pass.

Two acceptance constraints remain explicit: detection plus the original 20s grace
may leave no overhead inside the unchanged physical 25s criterion, and a candidate
already established/probed before cancellation can have called runtime.resume.
The short/flap physical profile still requires zero such attempts/resumes. No
assertion or timeout was relaxed and neither constraint is claimed passed.

## D30 failure-preservation coverage

Initial setup now seals failure under its original 25s before an independent
at-most-10s observation. Pure tests verify actual phase, expired-context separation,
scope refusal, no Entry for unknown scope and explicit Mac/Windows directions.
Thirty named cases and focused vet passed under the two frozen diagnostic files.
The native Windows stop helper has a separate actual Kill path test, while the
unchanged Unix five-second timeout lives in a platform source file, not t.Skip.

Program injection failure also defers one bounded stack snapshot before owned
process cleanup. This includes the original-WS EOF exit that D28 did not sample.
The already-existing 45s deadline observer suppresses that extra observation;
diagnostic time is never business recovery time. Unknown attempt scope remains
unknown and cannot issue Entry. No test starts or reconnects a workbench to make
the diagnostic succeed.

The final local D30 supervisor race log has 56 named passes and its diagnostic
pure/Unix-stop race log has 24, both with zero failure/skip, under
`.run/d30-unit-final-20261020/`. The same independent reviewer found no actionable
issue in the deferred program observer, including Goexit ordering and suppression
of the existing deadline observation. Desktop source operator outputs under
`.run/d29-source-final-20261020/` pass all nine commands: environment, format,
architecture, type check, 1,893 desktop tests, service/visual smoke, renderer and
Electron source build. The parent app validator also passes. No local installer
was built. Static test integrity passes; default interactive/physical verification
does not.

The separately executed Windows stop helper passed its three native cases once,
with exact binary `e5571eb6…`. Its own shared diagnostic allowlist source changed
while preparing that run, so its receipt correctly records input inconsistency
and `finalCurrentSourceAccepted=false`; the other three sources and uploaded
binary were unchanged. This is supplementary native behavior evidence, not final
candidate acceptance. Its exact owned process exited and its unique Temp was
recoverably moved to a retained path; no installed client/core or credentials
were touched. Final matching source/CI evidence is still required.

A subsequent fresh `7c3ff587…` Windows helper binary matches all four frozen
stop-helper source files before/after compilation and native execution. Its sole
native attempt passed all three cases with no failure/skip and unchanged input
hashes; evidence is under
`.run/d30-stop-platform-20261020/final-windows-native-69703f82fa43/`. The exact
owned process exited and only its unique Temp was recoverably retained. This
closes the four-source helper evidence gap, not physical or full-product gates.

The root's final recorded D29 peer/session/bridge race log passed 410 named cases,
zero failure/skip, in 81.375s / 12.273s / 8.549s respectively; vet passed. Raw logs
are `.run/d29-peer-final-20261020/race.jsonl` and `vet.log`. The complete client
source digest before/after those commands was
`b4f964cdc8c563d5e051407f4aed2d6711a5e4ee6e28354ecc58e29a2505f554`.
Any following evidence-pointer metadata edit must occur before the next physical
freeze and get a newly measured digest; no physical run is active now.

## Read-only ICE ownership exclusion

A focused independent source trace found no production path reusing an Agent,
UDP socket or static ICE credentials across attempts. Each session constructs its
own SettingEngine/API/PeerConnection; the pinned webrtc v4.2.18 / ice v4.4.0
gatherer creates an Agent with fresh credentials and separately owned sockets.
Exact attempt/ticket routing and one-time SDP admission prevent a replacement
from applying another remote description to the original session. Retirement
closes that session's transport, not another live Agent.

This excludes a source-level shared-owner hypothesis, not the physical failure.
The next failed scene still needs the actual socket/task-loop stack and admission
evidence. A packet at the interface alone cannot establish socket delivery,
USERNAME admission or MESSAGE-INTEGRITY success. No credential was extracted,
logged or compared in this source-only investigation, and no IPv4-only or relay
substitute was introduced.

## Coordinator CI pin

Quality now builds the independent coordinator at commit
`9665b122899ef58be109e9ff16bbedc90a57708d`. Its shutdown changes retain the
initial listener cause, join their actual cancellation owner and preserve an
admitted response through net/http's final flush. Deterministic real UDP/TLS
barriers were red before the repairs and green afterward; independent review
closed the findings. The existing server CI manifest now includes these tests
without removing the original full-suite/build/process-smoke commands.

This pin is not a successful CI or deployment receipt. The exact new commit's
server CI, client CI, physical recovery, eight-hour idle and native interaction
gates remain separate. The completed earlier Mac full run belongs to its older
known-flush-defect snapshot and cannot certify this commit.
