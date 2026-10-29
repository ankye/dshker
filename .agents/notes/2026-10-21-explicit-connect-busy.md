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

## Final delivered Windows candidate and remaining acceptance

Production source 5cd505dd41efa49f82fcf7ca0a3a29c3a12fb66a retains a confirmed
same-revision login through non-authentication refresh refusals. The final local
desktop run passed 1,933 tests with 16 existing platform skips and the explicitly
excluded worktree fixture. Source builds, types, formatting and strict OpenSpec
passed. The independently reviewed Go production source is unchanged from its
20-package race pass.

Quality 39601044649 and Package 39601044712 both passed at 5cd505d. All six native
and six CLI targets passed their gates. The formerly failing legacy certificate
case passed inside 17 real Linux credential cases; 56 real Windows background
process cases passed. Earlier failures remain preserved and are not relabeled.
The first Windows ARM64 rename and Mac x64 smoke failures have no proven causal
diagnosis; the new source's successful gates do not establish one.

The locally built, metadata-verified and smoke-tested 5cd505d Windows candidate
was installed normally into D:/Applications/DSHKer Launcher, exit zero. All five
installed executable/asar/core/manifest/runtime payload hashes match the exact
staged package. Original roots, installation catalog, computer catalog and
selection file hashes are unchanged; both application shortcuts point to D.
Three public account-tab entries passed the shared-label diagnostic. A second
default-integrity execution also passed its real coordinator command and three
public UI observations. The public Run/add-computer controls opened the original
Mac workbench without busy refusal; its guest reached complete with a real app
root and 53 interactive controls. Fresh authority readback confirms original
Windows 0.1.95 and Mac 0.1.94 online with the original active network/pair.

The complete interaction gate remains FAILED: actual display refresh period and
complete pixel-frame coverage are unproven. The raw ledger preserves null values
and releaseAccepted=false. Its initial JSON-selector serialization defect was
fixed only in the test runner, retaining original JSON/AX plus a plain observed
tree; the final verify failure now explicitly names refresh_period_ms. This is
not a release-acceptance pass. Sections 9.4 and 10.3 remain open for that reason.

No v0.1.95 tag or Release was created. The verified same-source Mac ARM64 DMG is
ready, but the original Mac installation/processes remain untouched while the
user decides whether to update and interrupt that workbench. Public 0.1.94 stays
immutable. This follow-up note and diagnostic-serialization fix do not change
the delivered production source or its recorded artifact identity.

## Explicit 0.1.95 publication request

The user explicitly chose not to update the Mac, then requested publication to a
Git tag. The Mac installation and its current processes remain unchanged. The
previously disclosed failed native interaction gate and incomplete eight-hour
verification remain failed/incomplete; this request authorizes publication and
does not establish acceptance or close OpenSpec tasks 9.4 and 10.3.

Annotated v0.1.95 was created and pushed at the exact validated and installed
production source 5cd505dd41efa49f82fcf7ca0a3a29c3a12fb66a. Remote object
60c32ce39eeb1c342ea3e9ec4fc675cca2e0a475 resolves to that source. The later
fd9d8db changes only diagnostic tests and evidence. Same-source main Quality
39601044649 and Package 39601044712 were rechecked as successful before the tag
push. No existing tag or Release was overwritten.

Tag push triggered Package 39614812762, which rebuilds and verifies its native
desktop and standalone CLI targets before creating the Release from the exact
bilingual CHANGELOG entry. That entry retains the known limitations. No installer
or local process was changed as part of this publication request.

Final independent readback confirms public stable/latest Release 419657247 at
https://github.com/ankye/dshker/releases/tag/v0.1.95, published at
2026-10-21T14:26:58Z with 25/25 uploaded assets. Its annotated tag resolves to the
exact source above and its bilingual body matches the tagged CHANGELOG entry.
All six desktop manifests have the correct source/version. GitHub's SHA-256
digests for all eight desktop installers and six CLI archives agree with their
checksum files and manifest entries. Only nine small metadata files were
downloaded for this independent check; the actual build/publish assembly
separately hashed the binaries. No large binary download or installation was
performed during publication.

All target build, smoke and upload steps succeeded. The Actions API initially
returned queued/null after publication; a later fresh read confirmed Package run
39614812762 completed successfully at 2026-10-21T14:30:31Z and its Publish job
succeeded at 14:27:01Z. Raw evidence is under
.run/release-0.1.95/tag-39614812762/, including
independent-release-verification.json and tag-source-verification.json. The Mac
installation remains unchanged and all prior native-frame/eight-hour limitations
remain open.
