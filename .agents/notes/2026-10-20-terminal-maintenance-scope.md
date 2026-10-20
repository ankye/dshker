# D27: ordinary maintenance is not fresh authorization

Independent release review found that a catalog event for service A and ordinary
system resume still called `peer.autoconnect_clear_refusals`. The core discarded
all terminal entries and attempt counters, including service B, without an exact
durable authorization or epoch change. This contradicted D18's scoped intent
ownership. D27 is recorded in the active repair change before implementation.

Remove that unreleased shell method, TS port, Host branch and Engine method;
there is no compatibility alias. Catalog changes only reconcile. Resume retries
transient work through RetryNow without clearing terminals. Only the existing
exact successful durable Reauthorize publication advances that intent's epoch;
late old terminal/transient results cannot poison the new epoch or overlap its
connect owner. Limits, recovery deadlines and network selection are unchanged.

## Evidence and limits

- Real shell catalog/resume callbacks, normal management and selection tests:
  10 TS files / 173 tests passed. These use test-only core dispatch, not a live
  coordinator or native UI.
- Host helper full race suite: 450 named cases passed in 88.148 seconds; raw
  `.run/d27-terminal-maintenance/helper-race-final.jsonl`. The first failed
  test precondition and its raw JSON remain preserved. No native credentials
  were used: this suite uses in-memory identities and TLS fixtures.
- Engine exact-scope/epoch/single-owner races passed twenty repetitions;
  localrpc and actual core Handle admission regressions passed. Production
  references to the removed method are zero; negative tests retain its name.
- Core CI fixtures now derive explicit workbench generations from a completed
  owner and observe automatic recovery instead of racing it with Connect.
  The shared D24 bootstrap helper bodies were moved without changing behavior.
  Optional prebuilt test binaries require both an absolute regular non-symlink
  file and its exact SHA-256. Invalid inputs fail; a failed build never falls
  back to a guessed executable.
- Two native Windows core cases passed diagnostically, including five refusal
  matrix rows. D27 was still being edited, so these are not frozen-source or
  final CI acceptance. Original application processes and credentials were not
  modified by those isolated tests. Final-SHA CI remains required.
- Independent review found a remaining test-only race: after an exact completed
  refusal was observed, an automatic successor could promote before the old
  generation's Entry read. Its strict helper now accepts only not_connected or
  stale_generation with no URL; success and every other error still fail. It
  never reconnects or invents a generation. Fifteen top-level / 114 total pure
  race cases passed in 1.274 seconds; raw
  `.run/peer-ci-integration-39392280651/owner-entry-history-race-final.jsonl`.
  Independent read-only re-review closed that finding with no remaining
  actionable issue in the D27/fixture scope.
- Final desktop source tests passed 1,893 tests with zero failed, pending or
  todo tests; renderer/Electron source builds and parent validation passed.
  Source-size measured 337 changed code files with zero failures. Raw source
  results remain under `.run/d27-source-final-20261020/`. These are source
  checks, not a frozen physical run or final package acceptance.

Physical pause/crash, eight-hour original-session idle, native interaction and
default test-integrity verification remain independent release gates. Historical
failed scenarios are not replaced or relabeled by these local results.

## Native account baseline established by the user

The official CI artifact for `210d49d` was SHA-verified and opened read-only from
its mounted disk image after confirming the original Mac application had exited.
It is a diagnostic candidate, not a package of the pending D27 edits. The first
account view had no login session; a metadata-only Keychain lookup confirmed the
record was absent, without reading a token. Its historical cause is unproven.

The user logged in themselves. The actual native account view then showed the
existing account, device `27155491a755` and network `a23b51c5485d`. Normal Cmd-Q
was observed to end the candidate Launcher/core/owner processes. After opening
that same candidate, the public account page restored the logged-in account and
the same device, network and two device rows without another login. The window
close / application-open path retained the same process identities and account
view. No logout, reset, network removal or pairing mutation was performed.

This proves one normal restart on that diagnostic artifact only. It does not
explain why the earlier session record was absent, prove an overnight lifetime,
or replace final-candidate interaction evidence and its required raw ledger.
