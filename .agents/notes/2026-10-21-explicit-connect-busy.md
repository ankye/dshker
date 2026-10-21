# Explicit Run-page connection behind background preparation

The user reports a Run tab remaining on `p2p.connection_busy` after version
0.1.94. The current saved original Mac network is active with unchanged identity.
The running Launcher/core report version 0.1.94 and the expected released core
digest. Its process is currently running from the legacy installation path even
though the registered install points at the data-drive application directory;
preserve both until the next exact-artifact update is verified.

## Diagnosis and ownership

The installed diagnostic log shows previously healthy bidirectional ICE/data
channels ending together on process context cancellation. The new core later
reports repeated `peer.connect: p2p.connection_busy` without a new ticket/control
or transport trace. This identifies pre-ticket ownership as the immediate
investigation boundary, not proof of a new ICE failure or server rate-limit loop.

Source inspection independently finds that the Electron connect handler wakes
background retries twice before calling the core. Go already repairs that exact
account's signals. A background bind-only candidate can therefore win the slot
before explicit workbench intent is admitted. That reservation exposes an empty
state until its ticket/transport exists. The renderer's global refusal field and
late-callback readback gap can retain a historical busy hint indefinitely.

Implement only the existing desktop/core connection workflow under D38. Preserve
unique candidate authority, durable unknown prepare resolution, exact generation,
selected account, original pair/keys, background resume-only permission and the
Disconnect cancellation barrier. No new renderer capability, persisted identity,
network selection, enrollment or process restart is a substitute for the fix.

## Evidence and execution

Source regression, race, real coordinator, public-control and final artifact
readbacks are pending. Keep each stage and original failure explicit. Diagnostic
and build outputs use the designated data-drive roots; no worktree is created.
The prior 0.1.94 release remains immutable. Any later package/update must record
its own source and installed identity instead of relabeling the old artifact.

## Follow-up account presentation contract

The user confirmed the Mac was running, then logged in again. Read-only SSH
confirmed original Launcher/core/owner PIDs remained unchanged. Before that login,
the core repeatedly reported secret_missing and user_login_required; afterward
the original device, account and network recovered signalling and actual direct
UDP/data-channel readiness. The user confirmed Windows could connect. This is
installed 0.1.94 evidence, not proof of the pending source fixes.

The user then explicitly required the footer and Account and Network to show one
consistent authentication state, including signed out if no valid user session
exists. D39 owns this visible behavior. A healthy core/transport must not imply
user login. Preserve pending/failed read semantics, selected-service identity and
newer login/logout authority when asynchronous results arrive late.

## Frozen source verification

- Final local desktop suite: 196 files passed, 1 existing platform suite skipped;
  1,920 tests passed and 16 existing platform tests skipped. The separate
  launcher-version-store test is explicitly excluded because it creates Git
  worktrees, which the user forbids. Do not represent this as an unqualified
  all-tests invocation.
- Native Go internal and command race run: 20 packages passed, 1,744 named
  tests/subtests passed, 27 existing platform skips, zero failures. The complete
  helper package finished in 152.730 seconds. Both modified Go packages also
  passed vet and independent ownership review.
- Real independently launched production coordinator plus two production Host
  compositions and actual isolated DSH processes passed the existing cold
  restoration/concurrent directory and workbench case in 36.176 seconds. This
  is real integration evidence, not a physical Mac/Windows UI claim.
- Final renderer and Electron source builds, environment, architecture, service
  and visual smoke, types, formatting and strict OpenSpec validation passed.
  Original regression failures remain in the ignored connection-busy and
  manual-candidate-recovery evidence directories. Test-integrity authoring
  passes; default verification and public artifact/UI readback are separate.

The source is prepared as version 0.1.95. Its interaction contract and public
UI runner must keep DOM/rAF observations distinct from actual compositor pixel
coverage. Missing frame evidence cannot be filled with zeroes or relabeled as
physical/native acceptance. Candidate installation, public source/artifact
identity and any final publication need their own evidence.

## Installed candidate observations and retained failures

The exact main-CI Windows x64 candidate for 77dedd7 was verified and installed
under D:/Applications/DSHKer Launcher after a normal close of the old C-drive
process. The installer exited zero and the program reads version 0.1.95. The
original Mac process and credentials were not changed. A public native navigation
through Remote and Account showed footer, network badge and account card all
displaying the same signed-in label and the original Windows device ID.

The diagnostic runner first encountered a hidden window, then an unconfirmed
startup read; those input failures remain preserved. After native activation
and public account navigation, its first two tab entries showed all three
signed-in labels in about 30 ms and settled in about 92 ms. The third retained
actual failure: user.current was rate limited and changed all three labels to
unknown. D39 now distinguishes a failed refresh from revocation of a confirmed
same-revision login. Keep the original failed raw frames; do not count this run
as acceptance or replace its unknown pixel fields with zeroes.

Same-source CI also retained three independent failures: Linux legacy
certificate-recovery setup exhausted the documented IP budget before the actual
scoped recovery; Windows ARM64 failed an atomic runtime-stage rename with EPERM;
macOS x64 packaged smoke produced no final JSON after height adaptation.
The legacy fixture now separates setup and selection/recovery using its existing
budget boundary without changing limits, business retries or the overall
deadline. Local Linux compilation alone is not a real Linux credential pass.
No tag or Release was created for this candidate.
