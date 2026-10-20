# Candidate control and selected-account bootstrap ownership

This note supplements the approved `repair-open-workbench-reconnection` D13-D18
implementation. It is client Go source/test evidence, not physical Mac/Windows,
long-idle, deployed-service or release acceptance. Original installed processes,
providers and credentials were not changed.

## Candidate authority

Each direction has a retained primary and a distinct candidate. A suspended
primary keeps its attempt/generation/path/runtime generation; candidate progress
does not publish primary readiness. Only current v2 registration/account/epoch
events may admit a candidate. Unknown legacy `attempt` events fail admission;
the destructive legacy Manager start/run/connect path is removed, while the
independent v1 control-plane API remains explicitly isolated.

Candidate IDs are source-generated 128-bit values. Device/account/network/pair
identities remain 12 hex characters. Signed tickets, immutable exact-scope
readback, both Ready flags and source-only commit determine promotion. A private
candidate gateway performs authenticated HTTP/WS checks without reading renderer
cookies. Promotion keeps the target staged listener and retires only the source
gateway's previous ingress cohort before publishing the successor mux.

D17 treats `p2p.rate_limited` as a temporary control refusal. Once Prepare is
dispatched, malformed/invalid ticket or state responses cannot discard its known
ID. Only an explicit no-effect refusal plus authoritative absence/permanent
scope revocation ends unknown admission. Registration/liveness/core races do not
prove absence. Ready, Cancel, State and Commit are serialized per candidate;
unknown replies keep the same ticket/deadline/resources. A dispatched Commit is
resolved by the Manager rather than the requesting RPC. Old-primary recovery
can guarantee preservation only before dispatch or after winning the Cancel CAS.

An End request has a separate lightweight owner keyed by exact attempt. It holds
only immutable ticket/reason and cancellation state, not transport/mux/gateway
resources. A lost, malformed or rate-limited reply remains owned after session
finish; retries use normal 1/2/5/15/60-second backoff and fresh current fences.
Only an authenticated matching End result, valid terminal readback or permanent
scope revocation ends responsibility. Scope refusal remains a typed refusal, not
a fabricated cancelled receipt. Manager Close and account changes cancel and
join these jobs. The 20-second transport grace, 30-second WaitReady, 10-second
HTTP bounds and 25-second external recovery gate are unchanged.

## Bootstrap fingerprint and lock ordering

The Host owns at most one bootstrap job per service. Its only retry whitelist is
`p2p.rate_limited`, `p2p.server_unavailable`, `p2p.signalling_not_ready` and
`p2p.registration_stale`. Certificate synchronization preserves its public typed
failure while retaining the actual carrier cause; only an explicitly whitelisted
carrier cause can retry. Provider failures, corrupt records, authentication,
protocol and identity refusals remain terminal.

A job captures the existing device/service/endpoints/service key/public key and
private key plus the complete existing account-session record (presence, token
and real expiry), service-removal revision and explicit account generation. The
device certificate/name/enrollment-owner projection are not login authority and
are not used to select an account; authenticated certificate maintenance may
update them without replacing the stable device identity. Every retry rereads
the same records and catalog service/forgotten-service fences, and verifies the
session through UserCurrent. It never invents expiry, logs in, enrolls, substitutes
the static device owner, or starts DSH.

An initial restore captures its fingerprint before any network operation. A
failed device.restore/user.current can schedule only the same pre-operation
session and generation. Login/register may schedule their newly persisted and
read-back exact session. The worker checks its guard before configure, under the
account lock before restore, and before catalog commit/activation. Missing
Manager and already read-only Manager failures both use this same ownership.

Lock order is intentional: cancel/join bootstrap jobs before acquiring account.mu.
Close and Forget remove admission/set closed/removal state under Host.mu, release
it, cancel/join jobs, then close account resources. Explicit account-changing
operations advance the generation and cancel/join before taking account.mu;
workers can therefore finish an account-lock wait without an owner waiting for
them while holding that lock. bootstrapMu protects only job/generation metadata;
it is released before waiting for job.done. Successful recovery wakes only fresh
catalog-authorized pairs for that service and transfers to ordinary maintainers.
The Host also joins its singleton reconnect engine on Close.

The D16 barrier remains New(capabilities=[]) -> fresh selected-account scoped
identity -> live pins/catalog -> ActivateCandidates. Pending pairs are readable
but do not grant a live pin. D18 now follows the user's explicit decision: retain
the existing freshly authorized exact network and ask for a first ambiguous
choice, while other unambiguous computers continue bootstrap.

## TURN startup and explicit network selection follow-up

Only the server's explicit `p2p.relay_unconfigured` response permits its STUN-only
deployment mode. Other TURN request failures no longer become direct-only
transport. Temporary refusals retry under the original ticket/slot, lease expiry
and prepare deadline; invalid credential fields, URL scheme, subject/expiry or
authorization fail typed. Tests drive the actual createCandidateTransport path
through a local authenticated TURN allocation and assert relay candidates in SDP.
Target startup belongs to the reserved session's done/join lifetime, not the
subscription receive loop. Already admitted tickets have one bounded complete-SDP
queue and one joined signal worker; unknown offers cannot create candidates.
Cancellation resolves the same ticket and Close joins waiting startup. No ICE,
grace, HTTP or physical deadline changes.

Two independent-review bootstrap corrections also landed: an active Manager's
certificate-only maintenance shortcut requires the actual selected account to
match; a failed capability activation must repair its own read-only subscription
before fresh pin retry. It does not rely on a second RepairSignals driver.

D18's table-2 named methods are pairs.network_choices (empty scoped data) and
pairs.select_network (exact pairId/networkId/userId/expectedRevision). Their
projection contains only userId, catalogRevision and grouped computer/network
names and IDs; no keys, secrets or SQL pair IDs. Fresh active identities are
grouped before pinning. A missing ambiguous choice has no live pin or active
Computer, while other computers activate normally. A stale saved row retains its
old nonempty network and revoked lineage, even when only one alternative remains.
Account changes never overwrite an immutable old-user Computer directly.

Selection holds account.mu, revalidates fresh current-account authorization and
catalog revision, and commits pins/catalog under the exact Manager registration
owner barrier. The callback performs persistence only, never network work. Two
different concurrent choices cannot both commit; a lost reply is resolved by
reading the same durable valid choice, never resubmitting another network. A
different still-authorized saved choice is p2p.network_selection_conflict; a
missing/revoked requested choice is p2p.network_selection_stale; actor mismatch is
p2p.user_scope_mismatch and catalog CAS retains p2p.catalog_conflict.

Explicit stale re-selection releases only the old local authority, marks the
exact old row revoked, retires it, then records the fresh selected scope. Old
session cleanup remains Manager-owned and may not join a callback while holding
account.mu. Retiring sessions are atomically moved out of all current slots into
a Manager-owned retiring set: late ready callbacks and CurrentState immediately
lose authority, but Close still joins cleanup and finish cannot delete a successor.
Unknown Prepare may install only its exact ticket into the retiring resolver to
cancel/finish; it cannot create transport or promote. Engine stage readback never
revives a removed current owner from its cached ready projection.

The catalog transition rules are not weakened. The approved internal
CommitTransitions accepts at most eight nonempty strict steps under the same
store/CAS lock, validates every AssertTransition, then publishes only the final
record once. Revoke/drop/fresh is a validated atomic workflow, not three durable
commits. Invalid middle/last steps and publication failure retain original bytes
and revision. The renderer receives no raw multi-step operation. Commit failure
rolls back unpublished pin mutations; publication-unknown reads the actual exact
choice and re-admits its fresh live pin before confirming retry success.
Stale registration cannot enter persistence. Ordinary choices reads are fresh
and non-mutating. Saved unresolved lineage survives even multiple authoritative
empty discovery results, with stale/empty choices rather than a later automatic
switch to the only alternative.

After a fresh explicit selection is durably published, only that exact
service/computer intent is reauthorized in the existing Engine. This clears its
former scope's terminal refusal/backoff and advances an internal result epoch;
ordinary transport/registration Wake never clears authorization refusals. An
old in-flight Connect remains the sole joined owner until return, but its late
terminal/backoff result cannot poison the new scope. It then wakes the fresh
epoch. Idempotent readback of an already durable choice still freshly re-admits
its pin before this boundary; unrelated intents retain their refusals.

## Ordered target commit admission

The retained cold-start failure showed a target still occupying its old
candidate slot when the same ordered subscription delivered the next Prepared.
A deterministic test reproduced that local order before the fix; it is not
treated as proof of a physical network cause. The target now locally promotes a
fully validated committed/current-active receipt before receiving the next
event. Under Manager.mu -> signaling-owner.mu it rechecks the exact owner,
subscription, current fence/epoch, selected account, target device/core, both
Ready flags and live staged mux/transport. The target path performs no HTTP or
Host callback inside this barrier; source promotion remains asynchronous. A
late pending Ready HTTP response or ordinary resolver cannot promote twice or
remove the newly admitted successor.

An exact committed target whose local mux/transport is already dead cannot
claim ready. Under that same admission barrier it exits the current candidate
map into the existing Manager-owned retiring set. Only the predecessor named
by the committed ticket's exact attempt/generation/scope may also lose current
authority; it becomes non-ready/remote-replaced, its old mux is stopped and
detached exactly, and its stable gateway is retained for replacement. There is
no rollback to old active authority, second candidate slot, unknown-offer
fallback or queued admission. Close still joins these retiring owners.

Carrier retirement is distinct from authorization retirement. Only the latter
sets scopeRetired and maps cleanup to End(removed). A dead committed carrier
uses End(failed) with its immutable original ticket: server semantics retain
the predecessor CAS when a successor is already pending, and an old exact End
cannot delete a committed successor. No cleanup result mutates a newer slot.

## Focused regression assertions

- `TestReadyUnknownReplyKeepsSameTicketUntilOwnReadiness` and
  `TestCancelUnknownReceiptContinuesSameTicketResolution`: 429, malformed and
  semantically invalid replies retain exact ticket/slot and require readback.
- `TestEndRateLimitKeepsLightweightOwnerAfterSessionFinish` and
  `TestManagerCloseCancelsAndJoinsUnknownEndOwner`: local completion does not
  forget server cleanup; owner shutdown joins it.
- `TestBootstrapRetriesOriginalSessionBeforeManagerAndAfterReadOnlyFailure`:
  singleflight recovery preserves original session/device and [] -> candidate
  capability barrier with zero runtime calls.
- `TestBootstrapRecordChangeForgetAndCloseStopOldWork` and
  `TestLogoutCancelsAndJoinsBootstrapBeforeTakingAccountLock`: changed scope,
  retained secrets and owner shutdown cannot resurrect old work or deadlock.
- `TestBootstrapTransientSetDoesNotHideTerminalOrProviderRefusals`: exact retry
  whitelist, no error/credential fallback.
- `TestCreateCandidateTransportRetriesTURNWithSameTicketAndActualRelayCredentials`,
  `TestCreateCandidateTransportOnlyExplicitUnconfiguredRelayAllowsDirect`,
  `TestCreateCandidateTransportRespectsOriginalLeaseDeadline`,
  `TestInboundTURNWaitDoesNotBlockSignalsAndCloseJoinsItsStartupOwner` and
  `TestTURNWaitCancellationResolvesExactTicketBeforeReleasingSlot`: real create
  wiring, typed refusal, immutable bounds and joined early resource lifetimes.
- `TestOwnCredentialMaintenanceRevalidatesActiveSelectedAccount`,
  `TestBootstrapRepairsReadOnlyOwnerAfterCandidateActivationDialFailure` and
  `TestLogoutJoinsActivationRetryDuringFreshScopedIdentityRead`: actual account
  handoff, failed WSS activation recovery by the same job, and cancellation/join.
- `TestNetworkChoicesDoNotInferFirstNetworkOrBlockOtherComputers`,
  `TestNetworkSelectionPersistsExactChoiceAndLostReplyReadbackIsIdempotent`,
  `TestNetworkSelectionConcurrentDifferentChoicesCannotBothCommit`,
  `TestNetworkSelectionStaleAuthorityRequiresExplicitReselectAndLegalRetirement`,
  `TestNetworkSelectionAccountHandoffNeverOverwritesOldImmutableScope` and
  `TestNetworkSelectionStrictAdmissionRevisionAndFailedFreshRead`: real catalog
  guards, first selection, old-authority retirement, CAS and strict named reads.
- `TestScopedPinCatalogCommitIsFencedAndFailureDoesNotPublishPins` and
  `TestNetworkSelectionMethodsArePublishedOnlyForShellRequests`: exact fence,
  pin rollback and the private method roles.
- `TestRetiredPrimaryCannotPublishDeferredReadyOrOwnCurrentState`,
  `TestManagerCloseJoinsRetiringSessionWithoutCurrentOwnership`,
  `TestRetiringUnknownPrepareResolvesExactIDAndCannotCreateTransport` and
  `TestPairStageDoesNotReviveRetiredOwnerFromCachedReady`: immediate ownership
  loss, deferred-callback fencing, exact unknown-ID cleanup and joined shutdown.
- `TestNetworkSelectionRetainsLineageAcrossEmptyAuthoritativeDiscovery` and
  `TestNetworkReselectionAtomicFailureAndLostPublicationReplyPreserveAuthority`:
  empty discovery cannot erase a choice; conflict/write failure and unknown
  final publication cannot fabricate readiness or lose a committed exact choice.
- `TestCommitTransitionsPublishesOnlyValidatedFinalScope`,
  `TestCommitTransitionsInvalidMiddleAndThirdStepLeaveOriginalBytes`,
  `TestCommitTransitionsConcurrentDifferentChoicesShareOneCAS` and
  `TestCommitTransitionsWriteFailureKeepsOriginalBytesAndRevision`: unchanged
  identity guards, bounded all-step validation, atomic CAS and real filesystem
  publication failure. Unix permission denial runs under an unprivileged user;
  Windows uses a held exact test-file handle without delete sharing, not an ACL
  or policy change.
- `TestReauthorizeClearsOnlyExactDurableIntentAndPreservesOrdinaryWakeRefusals`,
  `TestReauthorizeFencesOldInflightRefusalAndKeepsOneConnectOwner` and
  `TestNetworkReselectionReauthorizesOnlyItsExactEngineIntentAfterDurableCommit`:
  exact durable selection clears only its own old scope's terminal, late old
  completion cannot restore it, one Connect stays in flight, and the existing
  Engine connects/reconnects the freshly persisted chosen network.
- `TestTargetCommittedEventPromotesBeforeImmediatelyFollowingSuccessorPrepare`,
  `TestSupersededSubscriptionCannotFastPromoteTarget` and
  `TestDeadCommittedTargetReleasesOneCandidateSlotWithoutEndingSuccessor`:
  the first test originally failed at the retained old candidate slot; after
  repair a genuinely in-flight late Ready reply and repeated resolver preserve
  the next candidate. A stale receiver is rejected again at the slot barrier.
  A dead committed mux never reports ready, its exact predecessor stops serving
  without moving/closing the stable gateway, the immediately following successor
  answers a real signed SDP offer and establishes transport, cleanup sends only
  the old ticket with failed reason, and Close joins both retiring and new work.

Focused race tests pass. The complete related package check also passed:

```sh
go test ./internal/protocol ./internal/controlplane ./internal/peer ./internal/peersession ./internal/runtimebridge ./internal/autoconnect ./internal/helper ./internal/core ./internal/localrpc ./cmd/dshkerd -race -count=1 -timeout=120s
```

After the final Ready-own-readiness assertion, full peersession/helper race tests
passed again (28.643s/10.214s). After the final selection-lock/session-readback
change, full helper race passed again (10.086s). `git diff --check` passed. Joint
integration must still be recorded against its actual source/server artifact;
these checks do not waive D18 desktop interaction or physical/release gates.

The later combined D17/TURN/D18 source passes the same complete race command with
`./internal/catalog` added: all eleven packages passed, peersession 30.691s and
helper 21.592s. The original D18 account-handoff fixture failure (unimplemented
directory endpoints and an expected old in-flight authorization refusal) is
retained; the fixture now answers those real reads and types stale authorization
instead of assuming no request was in flight. An initial new TURN cancellation
test also exposed its own unlocked result read; it now waits for ready and reads
under the session mutex, retaining the exact cancellation assertion. These fixes
do not waive joint, desktop-selection, physical or release acceptance.

The final ordered-target/reauthorization snapshot passed this complete command:

```sh
go test -mod=readonly ./internal/protocol ./internal/controlplane ./internal/peer ./internal/peersession ./internal/runtimebridge ./internal/autoconnect ./internal/helper ./internal/core ./internal/localrpc ./internal/catalog ./cmd/dshkerd -race -count=1 -timeout=120s
```

All eleven packages passed (peersession 32.117s, helper 16.587s, catalog 1.771s,
autoconnect 1.073s). `go vet` on peersession/helper/autoconnect/localrpc/catalog
and `git diff --check` passed. Catalog Windows test cross-compilation passed;
the held-handle publication test was not executed on a native Windows host.
No D19 pause-controller files or native process actions were performed by this
client owner; those are separately owned test-support work.
