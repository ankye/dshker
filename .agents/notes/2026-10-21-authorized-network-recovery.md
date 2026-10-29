# Recover original network authority from stale local state

## Cause and requested behavior

On 2026-10-21 the installed Windows client retained a revoked catalog record for
its Mac peer while read-only authenticated coordinator checks confirmed the
original network and pair active and both devices online. Incoming peer
candidates reached Windows but failed with `p2p.pair_unauthorized` and
`pairKnown=false`. The local revoked flag forced network reselection even after
the coordinator's original authority was available. The user explicitly asked
for automatic synchronization instead of repeated manual reselection.

## Boundaries

Recover only from fresh active authority matching the original service, account,
network, both device IDs and both keys. Keep selected-session and registration
fences, catalog CAS and atomic legal revoked/retire/active transitions. Only a
durably recovered exact engine intent may clear its own refusal. An already
active unchanged record without a recoverable authorization refusal is idempotent.
Every successful `pairs.network_choices` operation passes fresh catalog/pin
publication before returning selected and its resulting revision. An unchanged
record uses a no-op CAS without a file write; this restores a missing live pin
after a lost publication reply even if no terminal refusal remains. A read
cannot claim recovery from an in-memory projection alone. Real revocation, a
foreign account, another network or device/key mismatch, unavailable reads and
superseded work remain refused or stale. First ambiguous selection stays explicit.

An existing terminal refusal is eligible only for `p2p.pair_unauthorized`,
`p2p.pair_revoked`, `p2p.pair_not_found` or `p2p.network_revoked`, and only after
the same fresh exact scope is durably committed. Identity, trust, lease,
device-authorization, runtime, transport and unrelated terminal errors remain.
The engine checks and clears its current exact stop atomically under one lock;
an intervening newer non-authorization failure retains its error, epoch and owner.

No server pair mutation, device replacement, cached authorization, new renderer
capability, parallel connection owner, DSH start, deadline or quota change is
authorized by this repair. Installed application files and user state are not
updated by source validation.

## Implementation and independent review

Production changes are limited to `networking/internal/helper/network_selection.go`
and `networking/internal/autoconnect/engine.go`. New tests cover helper recovery,
atomic engine refusal recovery and Windows real-coordinator integration; the
scoped manifest also binds existing network-selection and selected-session tests.
Independent review found two blocking gaps, both repaired with regressions: the
engine's observation/reset race and a lost store reply that left a durable active
row without a live pin or terminal refusal. Recovery now uses atomic current-stop
admission and every successful choices read publishes fresh pins through a CAS.

## Verification

The real isolated production coordinator/helper regression failed against the old
source and passed against the fix. Final default test-integrity verification
passed for two production and five declared test files; its real integration
runtime was 6.15 seconds. The raw coordinator evidence is recorded at
`.run/authorized-network-recovery/real-coordinator.jsonl`. It uses isolated
credentials and the production Windows provider, without modifying installed
accounts or starting DSH.

Six affected desktop suites passed all 28 tests after rebuilding the native core.
Its SHA-256 is
`d14b6b84f36b122e3fc76915047b11d81ec5536b6621e4ff108c87adada2ed47`.
The peersession and catalog race suites and helper/autoconnect vet passed.
Final focused helper/autoconnect races passed 89 named tests/subtests with zero
failures or skips; package times were 77.20 and 1.36 seconds respectively. The
selection was
`^Test(Network|RecoverAuthorization|Reauthorize|SelectedSessionAuthorityNetworkChoice|SelectedSessionScope)`
and raw output is retained at
`.run/authorized-network-recovery/helper-focused-race.jsonl`. It covers lost
publication replies without a terminal stop, fresh replies arriving after actual
logout, and catalog CAS conflicts preserving concurrent fields. All five
added/modified code files pass source-size checks. Scoped document/manifest
formatting and `git diff --check` pass.

Environment, architecture, type-check, service smoke, visual smoke, renderer
build and Electron build passed. OpenSpec strict validation passed after two
existing requirements' line wrapping was made explicit to the parser; their
selected-session and grace-recovery contracts remain intact.

The first full desktop run reported 1,875 passed, 5 failed and 16 skipped. Its
obsolete native-core failures were resolved by rebuilding and rerunning the
affected suites; this is not a fresh full-suite pass. The full entry internally
created and cleaned temporary Git worktrees, so subsequent verification used
bounded entries respecting the user's prohibition.

The full helper race command remains failed: the existing
`TestAccountAuthTransportSelectedTLSExpiryRaceNeverReselectsBase` reported
`p2p.invalid_device_certificate`, and the overall 180-second run timed out while
`TestCertificateRenewalIsSerializedAndCanonicalDefeatsStaleShell` was active.
The expiry failure also reproduced with both changed production files overlaid
from `HEAD`, at the same fixture setup line before network recovery is entered;
the unchanged current-source single case passed. The raw comparison is retained
in `.run/authorized-network-recovery/expiry-head-source.jsonl` and
`expiry-current-source.jsonl`. This confirms the pre-existing expiry fixture
issue only; the whole-package timeout is still not a full-suite pass.
Repository `format:check` remains blocked by the existing ignored
`.claude/settings.local.json` formatting; the parent desktop validator retains
three existing absolute-path findings. These broad failures are preserved rather
than relabeled by passing scoped checks.

At the user's request, task artifacts initially written on the system drive were
moved to the designated data drives. An exFAT build attempt failed and its log is
retained; subsequent native builds used NTFS temporary storage with a separate
data-drive Go cache. Generated artifacts remain outside committed source.
The final production core dependency admission and symbol scan found no authored
test-support dependencies or symbols in the built executable.

Installed application files and user data remain unchanged. No publication or
installed-app, physical Mac/Windows, overnight ICE, native UI or release
acceptance is claimed.
