## Context

See proposal.md. The observed Windows gateway stayed listening after the old mux
closed. Auto-connect requested transport only; it reached `connected` and stopped
without reattaching the earlier workbench. Main also retired the old generation's
cached URL and had no authoritative readback for the recovered generation.

## Goals / Non-Goals

**Goals:** restore previously explicit workbench intent in the owning Go manager,
reuse its gateway, and let the existing desktop entry operation read current
state. Keep real transport and workbench readiness distinct.

**Non-Goals:** persisted tab intent across core restart, new renderer capabilities,
new Harness APIs, broad UI redesign, changing Git/root selection, or
restarting installed production processes. The first overnight network interruption
is not yet attributed; this change repairs the proven recovery defect.

Runtime ownership additionally survives a network-core crash as defined in D12.
This does not persist the killed core's outbound browser intent or gateway.

## Decisions

### D1 — Manager-owned, service/pair-scoped intent

Record explicit workbench intent only through an admitted outbound connection.
Ordinary reconnect carries that intent; an inbound session does not create it.
Clear on explicit disconnect/revocation/removal/close. No new durable record or
credential is introduced. A core restart starts without workbench intent.

Rejected: requesting all workbenches in the background, which would start DSH on
every paired machine; retaining an old URL with a new generation, which would
claim current authority without evidence.

### D2 — Completion follows intent, not a generic connected flag

Transport-only intent is satisfied by `connected` or `ready`. An existing
workbench intent is satisfied only by `ready`; temporary runtime refusal follows
the existing widening retry policy with one in-flight attempt per service/pair.
Terminal authorization refusals remain terminal. Concurrent reconciliation must
atomically claim the attempt rather than replacing another in-flight attempt.

### D3 — Fence attachment mutation and cleanup

Keep gateway lifetime at the pair owner, independent of individual transports.
Install and detach only for the current attempt. A canceled or superseded
establishment must not mutate the attachment of its successor; cleanup must use
the mux it owns. Maintain separate inbound and outbound session maps.

### D4 — Core-authoritative entry readback

Add the named main-to-core `peer.entry` operation scoped by `serviceId`, `pairId`,
and `generation`. It reads the current outbound ready session and current local
gateway, returning `{ serviceId, state, url }`; it must not start DSH or establish a connection.
Missing/not-ready/stale pairs fail explicitly. The main process validates exact
reply fields, scope, generation, ready stage and a valid loopback HTTP(S) URL.
Existing renderer IPC admission and stable pair partition remain unchanged.
Recheck lifecycle and authorization after awaits, including disconnect, close,
and supersession. Never log entry tokens.

### D5 — Validation through real owners

Use deterministic focused tests for lifecycle, cancellation and race boundaries,
then isolated production coordinator/core/DSH processes for auto-recovery with
HTTP application-state readback and real WebSocket traffic. Explicit `Connect`
must not be used to disguise recovery. Measure attempt/generation/service/pair
ownership, same gateway, cookie/partition behavior, and original session identity.
Win/Mac candidate execution is separate from a local synthetic source test.

### D6 — Separate resume from explicit runtime start

Preserved intent is not permission to undo a target user's explicit Stop. A
background workbench reconnect uses a distinct peer resume capability/request,
without the old explicit `workbench.request` capability, and invokes the named
`runtime.resume` owner operation. That operation reads the actual running binding
only and never calls runtime start. Manual workbench opening continues to use
`runtime.connect` and its existing launch admission. Both owner callbacks remain
service/pair scoped and authorization checked.

Missing resume support is a typed refusal, not a downgrade to explicit start.
An older target therefore cannot accidentally treat recovery as permission to
launch DSH. No new renderer capability is needed. D13 separately extends the
server control protocol without changing this resume authority. Headless and
desktop owners implement the same bind-only semantics. Tests must prove that a
stopped target remains stopped under repeated automatic recovery.

### D7 — Closable remote browser guests

Supersede the historical non-closable remote-tab rule with the user's explicit
request. Local remains permanent. Each SSH/P2P tab has a visible, labelled close
button separate from its selection button; keyboard Delete on a remote tab also
closes it. Close destroys that guest and its page-navigation state, not the saved
connection, credentials, pair, transport or remote DSH. Core shutdown/Disconnect
remain distinct operations. Closing the active tab selects its right neighbor,
or left neighbor at the end; closing a background tab preserves the active tab.
Keyboard focus returns to the selected surviving tab after the DOM updates.

The existing add menu lists closed computers again. Ready connections open a new
guest without a duplicate connect; disconnected/failed SSH records reuse the
existing named connect operation, with pending operations disabled. P2P retains
its admitted connect flow. Late connect or entry results cannot reopen a closed
tab. Entry caching remains connection/attempt-owned and generation-fenced; it
does not own tab visibility. No new IPC, persistence or fallback is introduced.

### D8 — Preserve the first failure, fence grace expiry

Record the first actual termination cause once, before teardown can replace it
with closed/canceled consequences. Keep trigger, timestamp, current ICE/peer/
DataChannel state, actual receive statistics where available, lease expiry and
last successful renewal scoped to the service/pair/attempt/generation/direction.
Unavailable statistics remain explicitly unavailable. Do not log payloads, ICE
credentials, private keys, auth tokens, cookies, or gateway URLs. State changes
and bounded health samples, not packet traces, provide long-duration evidence.
Session shutdown must report its actual owner/transport/mux/endpoint boundary;
normal cleanup cannot overwrite the first causal record. Diagnostic work must
not add renderer capabilities, change public status admission or block callbacks.

A disconnected transport's timer is owned by that exact recovery window. A
Connected event or a later window invalidates the previous callback even if
Timer.Stop reports that execution already began. Test that interleaving
deterministically. Keep the existing ICE timeout and twenty-second grace policy;
do not call this race the original incident cause without matching evidence.

### D9 — Eight-hour physical baseline without manual recovery

Use explicitly supplied production coordinator/core and current DSH inputs with
isolated test identities on the authorized physical computers. Both original
HTTP cookies, workspaces/sessions and WebSockets must survive eight hours of zero
business sends while protocol readers continue normal heartbeat processing.
Failure is recorded at its actual time and remains failed; never reopen, redial
or restart a page/runtime to reset the interval. Existing controlled automatic
recovery checks remain separate and unchanged. Test TLS validity and outer owner
lifetimes must cover the requested scenario; extending these test-only resource
lifetimes is not permission to relax any connection/readback success threshold.
No installed client, original account/network or system power/network setting is
changed. A physical candidate core test is not native desktop UI acceptance.

The current joint candidate strengthens the same requirement: the original
bidirectional idle interval is followed by ten automatic recovery/readback rounds
in both directions, not ten earlier forward rounds followed by one reverse case.
Mac uses the production Engine plus Manager with an isolated catalog, not manual
Reconnect or full Mac serve. Test-control operations only observe the current
production state and perform original-cookie/session readback. Each round's
twenty-five-second context starts before fault injection and covers readback.
Outer scenario resources cover both directed matrices without extending that
per-fault threshold. Initial setup transfers only the newly issued test session
whose real expiry covers the scenario; restart never reimports it or logs in.

### D10 — Independent, explicitly authorized weak-network fault profile

Keep the zero-disturbance idle profile unchanged. Record its user-requested early
termination separately before starting the new fault profile; never classify the
controlled shutdown as a spontaneous ICE loss or an eight-hour pass.

Use fresh identities and evidence directories for inbound/outbound short outages
of about three seconds, inbound/outbound thirty-five-second outages, and five
three-second bidirectional flaps. Block only UDP belonging to the exact temporary
Windows core executable, admitted by path, hash, PID, parent and creation time.
All its UDP ports are in scope so a new ICE attempt cannot escape through a new
port. Do not alter adapters, global policy, original applications, SSH, Node or
TCP control traffic. These are test-only OS rules, not production hooks.

Before any enabled rule, prove a uniquely named Windows scheduled cleanup task
can remove a disabled probe rule after the controller dies. Its fixed deadline
must still be future at every enable; an expired marker and interprocess mutex
prevent enable-after-cleanup. Finally removes only exact owned rules and confirms
absence before retiring the task/files. No successful cleanup is inferred after
an RPC error; retain evidence and the independent task on unresolved cleanup.
Task scheduling is not an unconditional hard TTL when the OS is unavailable.

Restore observation starts at the first rule-removal operation and retains the
existing twenty-five-second acceptance budget, including removal/readback time.
Short outages must preserve their attempt and original WebSocket. Long outages
may naturally end a carrier; record its first error and verify the original
cookie, gateway, workspace/session and DSH runtime through the recovered carrier.
This does not prove a native webview automatically reloaded. Both peers use the
production auto-connect engine; the Mac test composition uses the real Manager,
catalog and engine without opening the shared Keychain, and is not binary-serve
or native-UI acceptance. No observer, control request or test calls Reconnect to
make the assertion pass. Each failed case remains failed and does not skip the
other independently enrolled cases.

The active network profiles must actually enforce local rules before a cut is
admitted. A disabled profile is a typed prerequisite failure, not an outage or a
recovery failure. The user explicitly declined enabling the Windows firewall;
the current disabled-profile run remains failed/inapplicable and is not rerun
until green. No automatic switch to another blocking mechanism is permitted.

### D11 — Explicit isolated peer-process crash verification

After the user's instruction to kill a process instead of enabling the firewall,
terminate only a recorded test-owned Windows core, verifying its exact path, hash,
PID, parent and creation identity. Preserve the original installed processes and
DSH. Restart that candidate with the same explicit test roots and existing
credentials/catalog; reattach the authenticated runtime owner using the normal
production lifecycle. Observers may not create new devices, networks, pairings,
peer-connect requests or runtime starts to make recovery pass.

The surviving Mac production engine/manager retains its original outbound intent
and gateway. Verify its automatic recovery through its original Cookie,
workspace/session and still-running Windows DSH. Record the naturally closed
carrier separately and retain the unchanged twenty-five-second recovery budget
from the restarted peer's admitted readiness. Test process restart is intentional
fault restoration, not automatic core-process supervision acceptance.

### D12 — Independent authenticated runtime authority

The real DSH supervisor, child process handles, reaper and output pipes belong to
one independent runtime-owner process. Both parent-driven and headless cores use
the same context-bound authority interface for start, stop, status, console and
binding. They never substitute a local supervisor after a connection failure.
The private owner mode dispatches before credential stores or peer hosts open;
it has no account, coordinator or Keychain responsibility.

The owner stores its OS lock and private identity beneath the exact registered
core state root. Its private localrpc endpoint uses a same-user Windows pipe or
an explicitly recorded, private short Unix socket directory; it never switches
transport to bypass a long path. A versioned private identity binds its random epoch,
authenticated endpoint, canonical configuration roots and executable digest.
Optional unconfigured roots remain explicitly empty. The inherited DSH home
context must match on reattachment without persisting secret environment values.
Unknown, corrupt, cross-root, incompatible or unreachable owner records fail
with typed errors; no process/port scan, URL cache, enrollment or replacement
owner is used to make recovery appear successful. A fresh root with no owner
record may create its first owner, but this alone does not start DSH.

A core crash or core-to-owner client disconnection leaves the owner and real child alive.
Reattachment queries the existing owner, preserving launch identity, binding
generation and console cursor. Only the live child announcement supplies a URL.
Start is serialized with Stop: an existing live subject is refused before any
port action; an occupied fixed port is refused, never cleared by command regex.
Explicit Stop invalidates the binding and joins the owned tree. Normal core
shutdown explicitly stops and joins its owner; transport disconnection is not a
shutdown command. A failed boot does not terminate a previously recovered owner.
It does clean up a fresh empty authority created by that unsuccessful boot.
The existing parent-driven core still exits orderly when its shell channel ends;
that is a normal core shutdown, not a promise to survive a shell-process crash.

The guarantee begins with launches created by this ownership model. An old
orphan whose original supervisor/pipes have already been lost cannot be safely
claimed. Owner-process death is a typed failure, not automatic PID adoption.
Private methods are owner.hello, owner.start, owner.stop, owner.status,
owner.console, owner.binding and owner.shutdown; exact payload admission and
authentication tests precede exposure. No renderer capability is added.
The six typed owner refusals (unavailable, identity mismatch, invalid record,
unsupported protocol, invalid configuration and failed shutdown) remain
distinguishable through both remote and local launch/stop result admission.
Local IPC must return its typed result rather than reject the promise or claim
the Harness checkout is missing. Both locale dictionaries explain the ownership
failure without recommending an automatic restart or replacement runtime.

Verify both production core compositions, original child identity and continuous
stdout/stderr across a core crash, unchanged binding/console identity, explicit
Stop, owner death, incompatible/corrupt records and normal cleanup. Keep the
original 25-second physical recovery criterion and all historical failures.
Runtime-owner proof is not overnight ICE root-cause or native UI acceptance.

The killed core's own gateway and in-memory workbench intent die with that owner;
the existing contract does not persist them. Do not claim its original port
survived or infer an outbound workbench request from transport-only catalog state.
Any missing account/device/runtime restore prerequisite fails explicitly and is
reported rather than repaired by manual re-enrollment or a hidden test hook.
Business readback is sealed before intentional test teardown through an explicit
identity-bearing close/join acknowledgement; an already failed reader cannot be
relabeled as an intentional close.

### D13 — Verified candidate handoff, not destructive reconnect

The approved joint change keeps at most one primary and one candidate per
service, account, network, directed device link. A primary is ready, suspended,
or terminal; ICE disconnected is suspended immediately, not cached ready and not
authorization revocation. Its existing twenty-second grace remains unchanged.
Transport events and authenticated peer-registration changes wake the existing
engine through a coalesced, fenced notification, without network work inside a
Pion callback or reliance on the five-second scan. The scan remains reconciliation,
not an alternate success path. A recovered primary can return ready in its own
window. A stale window cannot retire either a recovered primary or its successor.

Control v2 is separate from existing data/identity/share protocol version 1.
The private shell/core method-and-state contract becomes MethodTableVersion 2;
frame/bootstrap version stays 1. Both parent-start and attached-core paths reject
an unmatched contract rather than accepting a core whose states cannot be parsed.
The server and both current peer registrations must explicitly advertise
candidate support before prepare; missing capability is a typed refusal, never
a v1 Begin fallback. The existing explicit v1 API remains isolated: no v1 begin,
renew, end or signal operation may mutate v2 state. No default network selection
or inferred predecessor is permitted. `pairId` still means the target device ID.

The server protocol declaration is the wire authority for matching client DTOs:
WSS subprotocol `dshker.signal.v2`, hello control version 2, a fresh random
`coreInstanceId` per network-core lifetime (stable across WSS resubscription), and
explicit capabilities and mandatory `userId` (empty explicitly means signed out).
Authenticated ready and peer registration echo that selected account; nonempty
values require an enabled linked user, never a static device-owner default.
Both peers' current selected account must match the candidate's explicit userId.
Login, logout or account change resubscribes the same core under a new fence and
invalidates old-account operations/slots. WSS Ping/Pong alone measures carrier
health; v1 heartbeat success is not v2 registration or account authority.
An independent joined worker may report build/last-seen through the existing
heartbeat API; telemetry errors are typed and cannot end or authorize the v2
carrier. Directory v2 presence reads the server owner snapshot, not that legacy
heartbeat sample, so online devices cannot appear permanently offline.
Authenticated ready returns current `serverEpoch`,
`subscriptionId`, device and core identity. Ready needs no extra signature beyond
authenticated TLS. Every HTTPS mutation carries that current RegistrationFence.

The renderer retains only an already admitted guest with the exact primary
attempt/generation/runtime and catalog authorization while suspended; it labels
it recovering, not ready. Suspension cannot obtain a fresh entry. This preserves
the original page/WS across short recovery without authorizing a stale lineage.

The source pre-generates a random 128-bit candidate `attemptId`. Prepare carries
that id, explicit user/network/pair/generation, target core identity and exact
`previousAttemptId`/`previousGeneration`. Empty predecessor and generation zero
are legal only when authoritative link-state explicitly says no active link.
Prepare is idempotent by attemptId plus immutable business scope, predecessor,
generation and both core identities, excluding the current RegistrationFence.
Every invocation separately validates that current fence, so a same-core WSS
resubscription can replay a lost prepare with its new subscription. Different
immutable contents are a conflict. One direction's candidate never supersedes
the opposite direction. Source and target enrollment and network authorization
must be checked explicitly; SQL errors are errors, not missing membership.

A domain-separated `dshker.candidate.v1` signed CandidateTicket wraps the existing
SignedLease plus creation serverEpoch, exact predecessor, both core identities,
and immutable prepareDeadline. Initial ticket bytes never change. Renew returns
a separate same-scope latest signed lease. Ticket authenticity and immutable
scope checking are separate from time authorization: pending ready/commit must
be within deadline, but an old committed decision remains readable afterward.

Named v2 operations are links/state, candidates/prepare, ready, commit, cancel,
state, lease and end. Prepare leaves the primary active and renewable. Both
parties Ready their staged resources; source Ready means its candidate HTTP,
authenticated HTTP and WebSocket probe actually traversed the candidate, not the
old stable gateway. The core does not obtain renderer cookies; physical acceptance
separately verifies the original browser Cookie/session across the promoted path.
The target starts and retains a private candidate
listener before Ready; it promotes that same listener, never two Accept loops on
one mux. Background handoff only resumes an existing runtime; it never starts DSH.

Only the source commits. The server atomically checks current registrations,
scope, both readiness records, exact predecessor and candidate, then persists the
new active pointer and immutable committed decision in one SQLite transaction.
Only afterward may it publish events or clients promote. This is one authoritative
control decision, not a claim that both local endpoints change simultaneously.
Source promotion swaps the verified mux into the original stable endpoint under
an ingress barrier or exact connection-cohort fencing. It retires only old-mux
browser connections; the current Replace-then-DropConnections sequence is forbidden
because it can close a new connection. Probe gateway disposal must not close the
promoted mux. Never call start as a repair for a missing runtime binding.

At the target, an exact authoritative committed event must finish its local
candidate-slot handoff before consuming a subsequent ordered Prepared event.
Validate the current subscription, registration fence/core epoch, exact current
active ticket, both Ready records and candidate-owned live transport/mux under
the ownership barrier. The receive callback performs only local ownership work,
not Host callbacks or HTTP decisions. If that exact committed candidate's local
resources are already dead, it must not publish Ready: move it from the unique
candidate slot to the existing joined retiring set with `p2p.not_connected`.
The successor may then occupy the one candidate slot. Retiring cleanup retains
only the old exact ticket and cannot remove successor authority. A dead carrier
is not a scope revocation: its End reason is failed, not removed, which would
cancel an admitted successor. The exact predecessor named by that authoritative
commit must likewise stop claiming Ready/Entry or forwarding its old mux; mark
it remotely replaced, detach only its old mux while retaining the stable gateway,
and join its natural failed cleanup. Do not roll authority back to the predecessor
or emit Host callbacks from this target receive boundary. Do not add a
second candidate, unknown-offer admission or timer extension to hide the race.
An authentic committed event can be delayed beyond its signed lease snapshot's
expiry. Verify the complete historical receipt and exact current ownership first;
expiry must not prevent already-dead committed resources and their exact replaced
predecessor from retiring. Only a live promotion that grants new forwarding must
additionally satisfy current lease-time authorization. A valid expired receipt
cannot make a live mux Ready or create a transport.

Once prepare or commit is in flight, HTTP cancellation is not server cancellation.
The Manager owns candidate resources beyond request context lifetime. A known
attemptId occupies the candidate slot until authoritative cancellation/expiry or
commit is read back. `attempt_not_found` cannot prove cancellation of an in-flight
prepare. Reissue the identical prepare to resolve admission before cancelling it.
After commit dispatch, enter resolving: keep candidate resources and query exact
decision, even if the old primary recovers. Cancel and commit share the same CAS;
cancel after commit returns committed. State returns both immutable decision and
current active id/generation so historical committed is not treated as still active.
Explicit Disconnect/revoke closes both slots; natural predecessor carrier expiry
does not revoke candidate authority. Late cleanup is exact-owner fenced.

### D14 — Durable server control authority and safe rollout

The independent Gin/SQLite service owns one control mutex for registrations,
presence and candidate/active decisions. No hub-to-sessions lock inversion or
network I/O occurs under that lock; capture exact recipients, then send unlocked.
Schema 6 to 7 is additive, with candidate decisions and directed active pointers.
All authorization and CAS reads inside a transaction use its tx handle, not a
second database call (the service has a single SQLite connection). Service
signing identity, CA, users, devices, networks, bindings and pairs are preserved.

Before a restarted coordinator listens, one transaction explicitly cancels pending
candidates with `p2p.coordinator_restarted`, retaining their queryable decisions,
and restores committed active pointers within their signed lease expiry. It does
not restore READY, SDP or ICE. A fresh nonempty serverEpoch fences registrations;
old ticket creation epochs remain intact. Current authenticated registrations may
read old terminal decisions; pending mutation additionally requires current ticket
epoch. Active renewal requires both original core identities to re-register and
unchanged authorization. Replaced cores are explicitly refused. A new candidate
may CAS-replace the exact durable predecessor. Retain current-active decisions
while renewed and historical decisions through the latest signed lease/deadline;
do not discard a live receipt at a fixed post-commit interval.

The GoWorkspace change owns the server plan, migration and deployment evidence.
Repair only the ten demonstrably invalid go.work use entries as a local test
prerequisite; retain all valid modules/replaces and never disable workspace mode.
Local integration precedes Linux binary deployment. Production runs the verified
binary under its existing systemd service on 8443; back up matching binary/state
and retain TLS/identity, never build source on production or overwrite unrelated
website files. The user permits data disposal, but no reset is needed for a valid
additive migration. A rollback must restore a matching pre-migration snapshot;
schema-7 data must not be opened by a schema-6 binary.

### D15 — Restore the selected login, not the certificate owner

The original Device.UserID is immutable enrollment identity, not current login.
The private `device.restore` payload explicitly carries mandatory `accountUserId`;
empty means confirmed signed out. Keep Device.UserID original and require a
nonempty selected account to match authoritative current-user readback and device
membership. Missing membership or a failed directory read is a typed error, never
a switch to the enrolled account. This is part of MethodTableVersion 2 admission.

The core and shell use the existing native-provider `peer-user-session:<service>`
record (`token`, `expiresAt`) as the sole durable login source. Successful named
login operations persist and verify that complete session before publishing login
authority; current-user verifies an existing record and never invents expiresAt
from its user-only response. Explicit logout clears it and terminates old-scope slots. A headless
core restart reads this same record and verifies it through current-user before
restoring v2 registration. Missing record means signed out, not enrolled-owner
login. Corruption/provider or temporary server errors preserve the record and
fail explicitly, not signed-out substitution; only an authoritative expired/
unauthorized session permits clearing it. No additional credential store or secret
fallback is introduced, and tests use isolated providers rather than original
Keychain records. Initial test enrollment may establish this real user session;
core-crash recovery must read it itself without a manual login after restart.

### D16 — Explicit current-account pair identity and bootstrap barrier

The explicit device-authenticated read `POST /v2/pairs/identity` accepts exactly
`{registration,userId,networkId,pairId}`. Unlike directed link operations, this
read's `pairId` is the pairs-table record ID returned by explicit pair discovery.
It returns the existing PairIdentity shape with an exact matching pair record
and network; both member UserID values are the requested business account, not
either device's immutable enrollment owner. Device IDs, public keys, names and
certificates do not change. Legacy v1 identity and DTO semantics remain unchanged;
v2 discovery never falls back to v1 identity on rejection or an unavailable route.

The server linearizes caller registration/current selected account and database
authorization under the control owner and transaction: exact pair participants,
explicit network ownership, enabled linked user, active device bindings and
revocation/expiry. SQL errors propagate. Identity reads do not require the remote
to be online or candidate-capable; presence uses only the v2 registration snapshot
for this read. After the await, the client checks that account and registration
are still current before admitting the fresh identity to live pins.

Production restore requires `pins:[]`; persisted catalog rows and initial device
payloads are not live authorization. Bootstrap is explicitly two-phase: verified
selected login and original device -> v2 registration with `capabilities:[]` ->
fresh scoped identity/catalog and live pins -> same-core resubscription with
candidate capability. Account changes repeat this barrier, clearing old pins and
slots first. While read-only, prepare is explicitly refused by the capability
gate; no early candidate can be silently discarded before pins exist. Failed
bootstrap stays non-ready with its typed error and never substitutes cached pins.
Legacy pair listing may discover record IDs but cannot authorize another account's
network; discovery is filtered by the explicitly confirmed selected-account network
scope, never by a guessed shared network. This also prevents a failed live pin
from being published as a usable active computer in the catalog.

### D17 — Admission budgets and owned transient recovery

Joint real-process testing proved complete cold restore costs `12+P` requests
per device before directory refresh or candidate work. Two devices behind one
source IP exceed the existing twenty-per-second source limit. This is a production
NAT fairness defect, not permission to sleep fixtures, disable limits or lengthen
the unchanged twenty-five-second business recovery budget.

The server retains one atomic limiter call, global 1000/sec, source 20/sec, 1024
source keys and its existing minute cleanup. Only actually matched explicit
device-auth routes use `device:<canonicalDeviceID>`; these include `/v1/signals`,
heartbeat, pair discovery, TURN and registered v2 operations. Classification uses
the already verified TLS chain anchored exactly in this server CA, exact leaf/
PeerCertificates match, and valid Ed25519 key whose canonical KeyID matches CN.
This resource-principal proof is not current authorization: every operation still
authenticates full stored key, device existence/revocation and current fence.
Public, bearer, unknown and wrong-method routes use `ip:<RemoteAddr IP>` even with
a certificate. Headers, body IDs, accounts, core IDs and subscriptions cannot choose
or reset a bucket. Invalid/missing/cross-CA proof stays in the IP bucket. The STUN
limiter is unchanged. These limits do not claim to protect the TLS handshake.

HTTP `p2p.rate_limited` is an explicit transient refusal. Candidate operations use
the same owner, attempt, ticket, immutable prepare deadline and single-flight
state resolution/replay; no new id or stale ready is substituted. Ready/cancel
success with malformed, unsigned or invalid decision readback is also unknown,
not a permission to close a potentially committed candidate. Ready is confirmed
only by authoritative own-readiness or commit evidence; unknown commit resolves
durably. Failed End may close a broken local carrier but retains exact ticket/id
cleanup responsibility in an owned lightweight job until authoritative end,
permanent scope refusal, or explicitly cancelled/joined owner shutdown. A locally
closed resource is not a server cancellation receipt. No action extends a lease,
deadline, HTTP bound, grace period or the physical twenty-five-second clock.

Host owns one cancellable/joined bootstrap job per service for transient failures
both before Manager creation and while read-only awaiting fresh pins. The explicit
transient set is rate_limited, server_unavailable, signalling_not_ready and
registration_stale, using existing 1/2/5/15/60 second bounded backoff. Each retry
re-reads the original stored device and selected session and verifies CurrentUser;
it never logs in, enrolls, starts DSH or chooses the device owner. Other typed
authorization, missing/corrupt configuration and provider failures retain their
error and records without automatic retry. Caller cancellation is not a retry.
Successful bootstrap hands ownership to normal maintainers and wakes the exact
service's admitted intents. Close, service removal/forget and account-generation
change cancel and join old work; every retry rechecks current catalog/service and
removal fences so a retained credential cannot resurrect a forgotten service.
Bind a job to the original device/authority and complete selected-session record
fingerprint; changed records stop it, not silently switch its scope. Explicit
login/register/logout/restore and account-generation handoff cancel and join old
jobs before entering account.mu, never wait while holding the lock the worker
needs. Pure current-user confirmation cannot invent a new session record.

Per-device budgeting does not prove all startup traffic fits: directory bearer
reads still share the IP bucket and many pairs share one device bucket. Cold
startup, concurrent directory reads and recovered candidate operations must be
measured together through the real server with limits enabled. Preserve first
failures and report budget exhaustion; do not auto-rerun to green or start the
recovery stopwatch after throttling has already delayed the fault.

### D18 — Preserve existing network; explicitly choose an ambiguous first network

Review found one remote device can have active pairs in multiple legitimate
networks. Sequentially pinning all of them conflicts with the current one-computer
connection record and can leave bootstrap permanently read-only. Neither choosing
the first network nor swallowing the second pin failure is permitted.
The user approved retaining the existing network and explicitly choosing the first
network when one remote computer has multiple valid networks. Keep one catalog
record, connection identity and browser tab per remote device. Group fresh active
identities before pinning: reuse the saved exact network only if fresh scoped
authorization still permits it; a single unambiguous fresh network is sufficient,
but a new ambiguous remote has no live pin or active catalog intent until chosen.
Other unambiguous devices must still bootstrap. Missing/revoked saved authority
does not automatically switch to another network.

Add named private table-2 operations `pairs.network_choices` with empty scoped
data and `pairs.select_network` with exact `{pairId,networkId,userId,expectedRevision}`.
The former returns `{userId,catalogRevision,devices:[{pairId,name,selectedNetworkId,
state,choices:[{networkId,name}]}]}`; state is selected/required/stale, and no raw
key, credential or SQL pair-row identifier enters this new renderer projection.
Read fresh selected-user networks/pairs and scoped identity under the current
registration. A choice is never a caller-supplied pin. Selection must revalidate
current user, exact catalog revision and fresh active membership before pinning
and committing the exact network. An unchanged valid choice is idempotent; a
different still-valid saved selection is an explicit conflict, not silent switching.
Re-selecting after genuinely revoked authority must first revoke/retire the exact
old row and release only its old live authority before a fresh selected row is
committed. D36 separately permits automatic recovery of a locally revoked row
whose exact original scope and keys remain freshly authorized by the server.
These are legal logical transitions, not three separately published files. Add
the internal-only owning catalog operation `CommitTransitions(expectedRevision,
steps)`: under the same store/CAS lock validate each bounded nonempty transition
with the unchanged strict record/identity guards, then atomically publish only
the final record. No intermediate drop may become durable. A failed validation,
CAS or pre-publication write leaves original bytes/revision intact; an unknown
final publication is resolved by fresh readback. This primitive is not exposed
through renderer IPC. Preserve stale saved lineage even across repeated complete
empty discovery snapshots, so a later sole alternative cannot become a default.
Account changes, stale revisions, missing choices and failed authoritative reads
return distinct typed refusals, not first-network inference or a cached choice.
After a freshly authorized choice is durably committed, invalidate only that
exact intent's old terminal refusal and fence its old in-flight engine completion.
An ordinary Wake must not clear terminal errors; no global refusal reset or
parallel Connect is introduced for reselection. The same production engine must
automatically connect and later recover the new authorized scope.

The existing add-tab floating dialog owns selection. It lists each computer once;
an ambiguous or stale record opens an inline network-choice view within that same
floating layer, never nested modals or a permanent page expansion. Show network
name plus ID, no preselected network, a clear back/close action and visible pending
or error feedback. Prevent duplicate submission. An authoritative successful
selection may refresh the catalog and open/connect one tab; D36's automatic
original-scope recovery does not itself open a tab. Closing/navigating
while work is in flight must not open a late tab; preserve the committed choice,
resolve an unknown result by readback, and never submit another network as retry.
Mouse/Enter/Space activation, Tab/Shift+Tab containment, Esc/back and focus return
must match the current dialog contract. Reuse existing desktop tokens and reduced-
motion behavior; test long names/IDs and supported widths for overflow.

### D19 — Authorized program-pause fault profile, not UDP packet-loss proof

The user approved replacing the unenforceable UDP profile with approximately 3s,
35s and repeated pauses/resumes of only the isolated Windows test core, plus the
separate crash/restart profile. Keep system firewall/network/power policy and all
original installed processes unchanged. Preserve the failed UDP evidence and call
the new evidence program unresponsiveness, not UDP loss. The real bidirectional
28800s original-session idle and ten subsequent recovery rounds are unchanged.
Pause admission must prove exact owned executable/path, stable process handle,
PID/creation identity and bounded lifetime before acting. Independently owned
cleanup must ensure a failed controller cannot leave a test core paused forever;
record resume versus exact test-core termination separately. Missing safe native
API or cleanup proof is a typed prerequisite failure, not an outage or a pass.
After release, both production automatic owners must recover original surviving
gateways, cookies, workspace/session and runtime within the unchanged 25s budget,
without manual reconnect, tab reopening or DSH restart.
The controller, guard and parent hold hard monotonic lifetimes. UTC receipts
never grant a lifetime or recovery budget; additional timestamp sanity checks
may explicitly refuse a clock discontinuity, not extend the test. Release carries the Windows-boot monotonic tick;
the parent subtracts elapsed receipt/cleanup time before creating a monotonic
deadline and checks the same tick budget after both readbacks. Missing, backward
or expired ticks fail; a wall-clock rollback cannot grant another 25 seconds.
Before each physical profile, the same copied core/test binaries must pass both
independent controller-crash and runner-crash cleanup tests with original stable
core-handle liveness and authenticated RPC. Those preflight receipts are linked
by raw log hash; detached cleanup is not a normal resumed-profile success.
If the runner dies while its debugger controller and independent guard are alive,
release ownership passes solely to the guard: the controller retains the held
debug event and waits within its original monotonic hard deadline rather than
racing Continue/Detach. The guard terminates and joins only that exact controller.
Proof records `guardTerminatedController`: normal holds require false, the
externally killed-controller preflight requires false, and the runner-death
preflight requires true after actual guard termination/join. A failed defensive
release retains its immutable original error; a guard cannot turn an interrupted
normal result into a passing detached receipt.

### D20 — Explicit authenticated account transports and unchanged admission limits

The first deployed-server run passed public TLS, mTLS WSS and the candidate
control lifecycle, but ordinary concurrent directory reads and all scope cleanup
were refused by HTTP admission. D17 isolated only device routes: normal Bearer
account requests still share one IP bucket. Two Host cold restores require 14
IP requests before seed/refresh traffic; the complete adjacent plan requires
24–30 against the unchanged twenty-per-second source limit. This is a confirmed
classification gap, not proof of the original overnight ICE cause. Preserve that
failed run; do not sleep, increase limits or re-run unchanged until green.

The server explicitly registers matched Bearer-protected routes as eligible for
the same completed server-CA TLS device resource proof as device routes. This
changes only resource accounting: every Bearer session/current user/database
permission remains mandatory, and enrollment owner A never replaces selected B.
Public, unknown, wrong-method or unproved requests keep their IP admission. The
global 1000/s, source 20/s, 1024-source cardinality and cleanup rules do not change.
Do not derive a principal from a token/header/body or create a second quota.

The client explicitly records setup/device/closed account transport phases under
account.mu. Ordinary Bearer management/directory reads use the public transport
only in the product's pre-device setup phase. After successful certificate
preparation and publication of client/manager/device, they require that exact
device transport; missing/expired identity or closed state is a typed refusal,
never a retry through base. Current account selection, credentials and current
registration/fresh-pin checks remain unchanged. Account logout or A→B selection
does not destroy or substitute the device transport.

Named authentication confirmation/revocation owns its transport decision before
dispatch, independently of device activation. Setup explicitly uses public auth;
a fully validated valid original device uses its exact mTLS client, including
while activation remains pending. Only a fully validated expired original device
uses the named public auth path, without requiring an unexpired certificate.
Apply this same preselection to user.current, user.logout, selectedAccount and
confirmLogin. Missing client/record/key, malformed identity and closed state are
typed refusals, not setup inference. Never resend through base after TLS, HTTP,
401, 429 or certificate-expiry races. Identity, login/register, enrollment and
original-key certificate query/recovery retain their existing public contracts.
No completed authorization read is cached, removed or shared across an account/
fence boundary for this repair.

The legacy main-side recovery scope resolver also needs fresh user and membership
reads when an already bound certificate has expired. Its ordinary user.current /
directory.refresh calls cannot cross the new device-phase refusal. Add the named
main/core table-2 operation `device.certificate_recovery_scope` with exact
`{serviceId,data:{deviceId,token}}` and reply `{user,networks}`. This is a narrow
read-only recovery authorization owner, not a renderer capability or public
transport selector. Require the exact service's existing original device/key
record and unexpired durable selected session/token; confirm the fresh real user
and owned networks/device members through explicit public auth reads. Recheck
caller/lifecycle/session/original-credential identity after every read. Never
publish a normal directory cache, fake its revision, choose a network or expose
keys/tokens. Main uses that fresh user to read the exact remembered manual choice,
then checks unique selected network, current user ownership and original device
membership, preserving abort/selection/token fences and recheck before/after
certificate issuance. No manual choice still refuses; it never picks a sole
network. Existing ordinary methods do not switch to public after refusal.

Authentication confirmation (`user.current`) and revocation (`user.logout`) are
named auth owners with the explicit preselection above; ordinary network/
directory/device management remains device-bound. Real authorization and readback must not
depend on an unexpired device. For a pre-validated original device whose bound
certificate is specifically expired, return the actual confirmed authentication
result while recording typed certificate-recovery-pending device activation.
Do not attempt synchronous WSS/catalog/directory activation in that branch and
do not catch arbitrary WSS/network errors as success. Valid-device failures keep
their existing refusal. Main already maintains device online/offline separately
after login and must retain its precise recovery refusal, never claim ready.
Auth transport admission and post-auth activation admission cannot reuse different
unreconciled expiry snapshots. Before synchronous WSS/catalog activation, freshly
validate the exact original identity and pending/expiry state after the real auth
result. If the certificate expired while that request was in flight, the actual
confirmed user/session/revocation follows the named pending owner without dialing
WSS. This is explicit state admission, never catching a failed activation as
successful authentication. Whole Host.Handle tests must cross the real NotAfter
boundary for login/current/logout rather than only call a preselected client.
Logout's local old-authority revocation is independent of successful post-auth
identity validation. If the in-flight caller is canceled or the original record
changes, retain the actual auth/validation error and refuse new pending provenance,
but still fence the captured old account's signaling, pins, candidates, gateway
and workbench intent with its existing local-only owner, joining after account.mu
is released. Deleting a durable session must never leave that old Manager
authorized. This local revocation neither retries HTTP nor claims remote logout
succeeded. Check deletion failure and owner-close paths in the same matrix.
Only exact logout payload/session admission may cancel a matching bootstrap
owner. Bad input or a stale token must not cancel a new account's activation job
or mutate its generation. Capture, schedule and revalidation retain an explicit
per-service session-owner object (token hash/expiry, not raw token history).
Session revocation and worker generation are separate ownership axes: jobs and
logout admission independently retain their exact generation/job/owner fences;
the same session's revoked object cannot be replaced merely by changing the
worker generation. Local logout revokes that captured owner, including not-yet-scheduled
jobs, even if durable deletion fails. A genuinely new selected session has its
own owner; an absent old durable session is not a replacement and still requires
captured old-authority cleanup. No persisted schema or new IPC is introduced.

A recovery-only Manager owner fences the selected account locally and detaches
and joins the old signaling supervisor without dialing. A changed account/logout
clears its old scoped workbench/transport authority as ordinary SetAccount does.
An unchanged account must retain its exact opened workbench intent and stable
gateway while stopping new candidate admission, not replace the original runtime
or discard the address. Old cleanup remains owned and unconfirmed remote work is
not called complete. Certificate issuance alone does not clear pending: the same
manager must later reconnect read-only, freshly scope pins and activate candidates
before device activation is declared complete. That exact, previously proven
recovery-pending provenance remains pending after certificate issuance: main
confirms the selected account between issuance and device.restore. Its named
authentication operations may continue through the pending owner only after
rechecking the same original service/device/key/client and fresh durable session.
A still-pending owner whose certificate is now valid must use that original
device's newly updated mTLS client for auth reads without clearing pending or
dialing WSS. A transport choice cannot require active registration/candidates or
equate certificate owner A with selected Bearer account B.
A valid certificate by itself cannot send that intermediate authentication read
back through incomplete catalog activation; arbitrary valid-device network errors
cannot create this pending provenance. Real Host.Handle login→current,
persisted-session confirmation and logout tests must exercise this full boundary,
not test-only confirmLogin/token injection that bypasses main session publication.

Add red regressions for actual TLS device attribution on Bearer routes, unchanged
limits, invalid/logged-out/disabled users, revoked/foreign devices, selected B with
owner A, setup/expired/closed phases, no second public request after an mTLS
failure, and real same-NAT two-Host directory/candidate traffic plus cleanup
readback. Bounded admission diagnostics must distinguish source/global/capacity
refusal without tokens, secrets, body data or unbounded identity labels. Complete
local gates and independent review before another verified server replacement.

### D21 — One canonical certificate read per restore operation

The next source-unchanged cold diagnostic still failed after D20 authentication
repairs. Bounded actual server samples prove both certificate-query IP admission
and networks device admission reached sourceCount twenty, but do not provide a
full per-route request census. Both directions reached transport connected before
ordinary directory/explicit-connect requests were refused. Preserve that failure;
it is neither a 25-second timeout nor the overnight ICE root cause.

The first repair is restricted to the confirmed duplicate canonical certificate
read: restore owner resolution and its immediately following certificate
preparation must have one operation-owned adoption transaction. That transaction
still validates the original persisted service/device/key/endpoints, canonical
owner, certificate scope/time and current caller/session/lifecycle identities.
Its proof is private to that exact restore operation and discarded on completion;
it is not a reusable authorization cache or a new public capability. Keep every
existing fresh CurrentUser confirmation. A separate restore or certificate
operation performs its own fresh canonical query. Issuance or recovery mutations
still require their own independent authoritative certificate readback.

Any canonical-record update must atomically compare the captured durable record,
write/read back this operation's new record and advance its expected identity
under the credential owner's same mutex. A check followed by independently
locked SaveCredential is not a CAS and may overwrite an intervening replacement.
Do not recursively acquire that mutex or skip the next check for an own write.
Unpublished Manager callbacks must not acquire account.mu. Failed publication
owns only the newly created resources, and both renderer and headless restore
entry points must join their signaling work after unlocking, not infer joined
completion from Close or from an empty pins list.

Missing/corrupt credentials, stale account or bootstrap generation, logout,
replacement, cancellation, closed ownership and failed HTTP/TLS admission must
retain their typed refusal. A late result cannot publish a client, Manager, pin
or candidate for a new owner. Never select another certificate, account, network
or public transport after failure. No admission limit, retry interval, ICE/grace,
business deadline or cold-case concurrency changes.
Logout's exact session-owner revocation is already a local linearization point,
even before logout can acquire account.mu or delete its durable session. External
device.restore must capture and recheck that same owner as headless restore does;
generation equality and unchanged disk session alone are insufficient. Do not
increment a global generation or clear a new session's owner as a shortcut.
Normal first restore cannot require that an unrelated background job already ran;
any ownership capture uses the existing fully admitted session and cannot grant
new authentication or reset its revoked owner.
Current-user confirmation is also a read of the old session, not new login
authority. Both external confirmation and restore must refuse a matching revoked
durable session before cancelling/replacing jobs or incrementing generation.
Headless capture likewise retains that same revoked owner. A failed login must
not reset it indirectly; only a genuinely new successfully published session may
own new authority. Keep all job and stale-logout generation checks unchanged.

Add exact request-count regressions through real local TLS before another cold
run, including both fresh account reads, standalone fresh queries and issuance
readback. Count only bounded method/registered-route/status and opaque test
principal slots; do not log URLs, headers, request bodies, credentials or keys.
Distinguish observed counts from static possible call graphs and from the
server's throttled denial samples. This narrow repair is not assumed sufficient
for the device-source exhaustion. Directory single-flight, candidate decision
ownership or a different restore transport phase require a separately reviewed
follow-up design and evidence, not an unmeasured all-at-once rewrite.

### D22 — Candidate decision-owner handoff without cached authority

Code review confirms the early candidate observer and subsequent decision resolver
can both issue State reads; serializing HTTP with a mutex still queues duplicate
work. Ready also returns a complete validated receipt which the following
resolver currently discards before issuing its first State request. This is
request amplification, not yet a measured explanation of every device-limit
denial or of the overnight ICE loss.

Restrict this repair to two explicit phase boundaries. Before Ready, resolve or
cancel takes ownership, runCandidate must stop and join its early observer on
success, establishment/WaitReady failure and caller cancellation. An already
dispatched Cancel with unknown outcome retains exact manager-owned durable
resolution responsibility; cancellation of the observer cannot erase it or free
the candidate slot. All paths retain the immutable ticket/deadline and one slot.

Pass only Ready's same-call fully validated pending receipt to that resolver as a
one-use initial result. It must retain current account, registration, ticket, candidate
slot and operation fences. Historical committed alone is not permission to
promote: current active attempt/generation, both readiness records, valid lease
and original local ownership remain mandatory. Unknown Ready/Commit/Cancel
outcomes still require fresh exact-ticket durable State readback, not a snapshot
captured before dispatch. Do not suppress current active-pointer checks.
Successful Ready receipts that are already committed or otherwise terminal retain
the original fresh-State path, rather than treating historical active data as
current authority.

No general coalescer, completed-response cache, TTL, session mailbox, WSS receipt
replay or new wire/state field is introduced. Existing WSS notification handling
and the target's synchronous committed-to-successor-Prepared barrier stay in
place. Original polling intervals, HTTP/prepare/ICE/grace timeouts, admission
limits and the physical recovery clock are unchanged. Later decisions do not
reuse the consumed initial receipt. Deterministic real-TLS counts, observer
join/cancellation, lost/malformed/throttled action replies, historical versus
current active authority and all existing ordering regressions must pass before
the next cold diagnostic. A focused pass cannot stand in for that diagnostic.

### D23 — Shared selected-session denial and publication scope

The complete authority-tail review identified a finite shared surface: successful
authentication through report/catalog activation, both headless restore branches,
catalog/network selection including background/AfterWrite work, directory view
publication, and the named certificate-recovery authorization projection. Fresh
remote/durable credentials alone do not undo explicit local logout, especially
when remote logout and durable deletion failed. Preserve all prior REDs; closing
one Host entry does not prove these other owners are safe.

Use one private selected-session scope containing only the actual durable
session identity, exact local session-owner pointer, service/account identity,
lifetime and removal tombstone. It stores no completed HTTP authorization,
network, pair, certificate or ready result. Capture before the first authority
await, then carry the same scope through reads and synchronous publication.
Lower layers reuse the captured scope rather than recapturing whichever session
is current after an await. Genuine login/register captures the new session only
after actual confirmation and durable readback, never an old account's scope.
An active headless restore uses the same operation-owned canonical adoption/CAS
as the cold branch, not the unguarded standalone certificate-maintenance path.

Separate optional typed worker fences from session identity. Existing request,
restore and bootstrap owners publish immutable generation and, when required,
exact job-pointer metadata into their private contexts. A scope retains those
fences and rechecks them directly under bootstrapMu at synchronous commit; an
opaque guard passing before that lock is insufficient. Ordinary background work
does not invent an unrelated generation dependency. Only the existing named
AfterWrite/lifetime owner may derive a background scope from the same selected
session/owner, retaining service/lifetime/removal/revocation while dropping its
completed caller/job dependency; it cannot reread and select a replacement login.

Scope construction captures its previous guard immutably. Check examines only
its own scope. Context combines the captured previous guard with Check without
mutating either or recursively invoking its own installed guard. Reinstalling
that exact scope preserves any stricter guard subsequently added to the context.
Publish runs the current guard outside the revocation lock when that same scope
is already installed, retaining a later canonical-adoption constraint; otherwise
it runs the immutable constructor guard. A same-scope context missing its guard
refuses rather than weakening admission. It then directly rechecks the scope and
typed local fences under bootstrapMu before a prepared synchronous store/view
commit. Preserve Manager/signaling-to-bootstrap-to-store
lock direction. Callbacks cannot invoke Manager/Host operations, HTTP, WSS,
emit/announce or join. No credential-owner lock is acquired under bootstrapMu.
Read Host-protected account/removal/closed state under Host.mu, never as unlocked
map/field reads; do not hold Host.mu across the generic callback. Atomicity here
is with local logout/generation publication, not a new global Forget/Close or
remote transaction. Existing lifecycle pre/post checks and exact cleanup/join
remain mandatory; already-dispatched remote effects cannot be called undone.

Required selected-session capture accepts the real exact nonempty native record.
A separately named signed-out restore capture accepts only validated explicit
empty-account restore plus a successful authoritative absence read. Missing
arguments, provider errors, corruption and expiry are not absence. Changes in
either presence direction refuse. Signed-out scope can only support empty-account
read-only restore, never nonempty pin or candidate activation.

Catalog carries scope through every fresh scoped read and the existing
CommitScopedPins callback; candidate WSS activation retains pre/post checks and
is outside scope locks. Background tasks capture or derive their exact scope
before dispatch, not inside a later goroutine. Directory read returns its scope
with the view, and unlock-before-publication retains that scope through the
guarded view/token/revision write. Recovery scope keeps all original credential,
token, expiry and removal validation and additionally guards each read and final
issuance projection; it does not publish an ordinary directory cache.

Ordinary explicit caller-Bearer network/device data reads do not gain local
selected-session authority and keep their existing server authorization and
transport contracts. Do not globally rewrite those reads, cache completed auth,
add raw-token history, a new persisted schema, IPC, fallback, timing change or
admission quota. Deterministic real-TLS barriers plus actual logout429/deletion
failure must prove every tail before logout's own cleanup can hide a transient
bad publication. Retain new-login/independent-generation positives and exact job,
session replacement, cancellation/removal/close, signed-out and ordinary-Bearer
negative boundaries. Full cold/online/physical/native gates remain independent.

### D24 — Explicit physical-driver initialization ownership

The first D23 physical attempt selected the original Windows installation rather
than the previously verified isolated Harness fixture. Its dependency Junction
refusal is an input failure, not transport recovery evidence. Keep that failed
attempt and explicitly verify/select the existing test fixture; never repair the
original installation or silently select another runtime.

With the correct fixture, the production serve engine can finish an automatic
transport-only outbound connection before the driver submits its fixed generation
one business open. The original initializer also enables the catalog once; a
second enable must retain its production `catalog_exists` refusal. These are
test-driver ownership conflicts, not evidence that production starts two engines.

Repair only test initialization: retain the initializer's single catalog enable,
read back its exact enabled service/computer/pin/account authority, and establish
one explicit workbench intent using a legal newer generation after the observed
automatic transport owner's completion. Do not infer an absent state, swallow
stale/busy/exists errors, retry explicit opens, reset the manager or disable its
timer/Wake paths. Read back exact ready/entry identity before creating the
opposite-direction workbench. Preserve the production request and per-fault
deadlines, all original-session requirements and the separate carrier/native UI
tiers. Deterministic setup regressions precede a fresh physical attempt; both
previous failed attempts remain immutable.

Read the actual launch composition, not helper function names: every current
Windows physical recovery fixture starts production serve and must wait for its
real automatic transport. Do not invent an unused parent-driven alternate branch.
The Mac production Engine/Manager test composition remains a separate tier;
an error/timeout cannot select a mode, invent a generation or justify starting a
missing timer. Completed-owner admission retains exact available service, pair,
selected account/network and core identity, a nonempty attempt and a valid
nonzero generation. Missing/malformed/late or replaced-owner replies and
generation overflow refuse. A stale initial open remains a failure, never a
read/retry loop. Verify these boundaries deterministically without adding a
production IPC field or treating test initialization as physical acceptance.

The crash profile has the same completed-transport and read-only catalog setup
barrier before its Mac-to-Windows reverse open, but must not create a Windows
outbound workbench intent. Only the other applicable profiles perform that sole
Windows business open/entry readback. Route both paths through the actual shared
test preparation so pure regressions can prove no reverse open precedes the
barrier and the crash path makes zero Windows business requests.

### D25 — Answer-side candidate admission survives retirement

D24's physical 35-second pause failed its unchanged 25-second business budget.
The successful replacement's actual ICE check was fast; preceding candidates
waited for establishment without reaching checking. The two existing logs lack
Prepared admission/rejection receipts, so the exact physical loss is unproven.
The source nevertheless has a deterministic defect: an authoritative terminal
candidate keeps its inbound reservation through asynchronous transport joins and
the first End HTTP result. A following Prepared is silently discarded as busy,
and its offer then has no owner. A re-subscription can replay an old Prepared
without replaying its terminal decision, so handling only terminal WSS events is
insufficient.

Separate local reservation authority from exact resource cleanup. A fully
validated terminal receipt may synchronously move only its exact inbound pending
owner to the existing retiring set; asynchronous transport/End cleanup retains
that owner and cannot remove its successor. Never evict an unknown, pending or
still-current committed owner merely because a new ticket has a higher generation.

If a current, scoped Prepared encounters an unresolved inbound owner, retain at
most one typed, joinable admission owner for that directed pair: an immutable
new ticket and the existing bounded signal inbox, but no transport, runtime or
ready authority. This is not a generic signal mailbox, replay or retry. Its sole
worker reads the exact old ticket's durable State and verifies the full receipt.
Terminal or committed-but-no-longer-active evidence permits pointer-CAS retirement;
current committed authority must use the existing exact promotion/live-versus-dead
barrier, not cancellation by inference. Unknown, malformed or unauthorized reads
are explicit failures, not absence or permission to substitute another candidate.
Exact duplicates reuse the same owner; a different queued ticket cannot overwrite
it. Signal overflow is explicit and cancels only the exact owned attempt.

Before publication recheck Manager lifetime, selected account, pin/network,
subscription identity and registration fence, old owner pointer and queued owner.
Loss of any fence cancels and joins the admission owner. Close, account/network
retirement and old deferred completion must retain exact ownership. No subscription
receive loop waits for HTTP, transport startup, resource joins or End. Keep the
original ticket/deadlines, 25-second business criterion, production engine and
runtime resume-only contract; do not add blind resend, alternate routes or a new
wire/IPC/persisted schema. The independent deployed server remains unchanged.

Add bounded credential-free `candidate.control` receipts for Prepared acceptance
or rejection, exact reservation conflicts, queued/refused signals and verified
retirement. Include both event and actual owner attempts/generations, current
subscription/server epoch, core and selected scope, UTC and typed reason, captured
at the local ownership barrier. Never emit SDP, signatures, URLs, tokens, secret
records, arbitrary error detail or unbounded payloads. Deterministic actual-TLS
regressions precede a fresh physical run; the failed D24 evidence stays immutable.

Keep the validated terminal retirement outcome in the admission caller's typed
handoff receipt until its exact successor consumes it. Do not reconstruct that
outcome from `Manager.retiring`: asynchronous cleanup may remove the old entry
before promotion resumes. The receipt is limited to the exact previous owner
and queued job, is created only behind the full committed-admission barrier,
and does not convert arbitrary `not_connected` errors into terminal proof.

### D26 — Optional workbench refusal retains its verified device transport

Release CI reached a live direct transport, then lost it because runCandidate
discarded Establish's explicit workbench refusal and treated the missing gateway
as a failed connection. Retain the existing workbench.optional contract: a
negotiated refusal with no binding may commit a transport-only primary through
the same current-scope, both-ready and durable decision barriers. Its public
state is connected, runtime generation zero, an empty entry and the precise
workbench refusal; it is never ready. This is an explicit protocol outcome,
not a substitute runtime or a successful browser-open claim.

Store that refusal before either side dispatches Ready, including a target whose
committed event precedes its Ready HTTP reply. Keep it on the exact session so
suspension can project an empty error and transport recovery can restore the
original connected-state refusal. Preserve workbench intent and the existing
retry classification/backoff. An unexplained missing binding, malformed scope,
or a binding whose HTTP/WS probe fails still fails the candidate. A usable
binding always requires the existing candidate-specific probe before promotion.

When a transport-only candidate replaces a prior runtime carrier, detach only
that predecessor's exact mux before publishing the new state. Keep the stable
listener registered for a later verified workbench. Delayed predecessor cleanup
cannot detach its replacement. Do not broaden the existing recovered-predecessor
rule or infer current runtime health from an old generation alone.

Verify explicit refusal versus unexplained empty binding, failed HTTP/WS probes,
target promotion with blocked Ready, connected/suspended/connected refusal
projection, exact old-endpoint detachment and later ready recovery. Keep existing
real coordinator/core no-workbench and recovery tests; align independent stale
CLI/catalog/method-table inputs without treating all CI failures as transport loss.

The Windows packaged-smoke runner also owns its termination explicitly. Closing
its sole probe window must not trigger the normal Windows window-all-closed quit
before success evidence or failure diagnostics have been written. Smoke mode
exits only through its existing awaited result dispatch; ordinary desktop close
and tray behavior are unchanged. This is a release-evidence lifecycle repair,
not permission to skip a failed renderer check or extend a deadline.

### D27 — Ordinary shell maintenance cannot reset terminal authority

The final cross-layer review found that the legacy shell
`peer.autoconnect_clear_refusals` route still clears the entire Host's terminal
set and retry counts, ignoring its service envelope and without the exact intent
epoch fence. A catalog revision for service A or a normal system resume can
therefore restart a terminally refused service B. This bypasses D18's exact
durably authorized Reauthorize boundary and can amplify requests; it is not a
permission to bypass the coordinator's authentication checks.

Remove this global reset operation from the unreleased table-2 shell contract,
Host dispatch, Engine and shell port rather than adding a compatibility alias.
An old request receives the existing unknown-method refusal. A catalog revision
only reconciles; ordinary resume may clear transient waits through RetryNow but
must preserve terminal refusals. Only an exact durable network-choice publication,
including D36's freshly authorized original-scope recovery, may call Reauthorize
or the atomic RecoverAuthorization owner for its service/pair and advance its epoch.
Account/manager replacement retains its existing independent lifecycle semantics.
No renderer capability, server wire, fallback, timeout or quota change is added.

Verify actual shell catalog/resume dispatch, core method admission, independent
service A/B terminal isolation, transient retry preservation and a late old-scope
in-flight refusal after exact reauthorization. Do not replace fresh membership
proof with a catalog revision or mark background maintenance as new authority.

### D28 — Native pause receipts admit concurrent publication, not retries

The frozen D27 physical run passed its 3s and 35s business pauses, but the
independent parent-gone safety preflight failed before the flap business case.
Its first recorded read failure is a Windows sharing violation for paused.json;
the failure path released the controller early, then an outer file-only wait
hid the runner's early exit behind its original 85s deadline. The actual holder
of the conflicting handle was not captured. This is not evidence of an ICE
failure, a leaked writer, or an antivirus cause. The writer already closes its
synced temporary file before Rename.

After retaining the aggregate FAIL, every raw hash and the owned packet/process
cleanup receipts, end that freeze only for a test-helper repair. Windows receipt
reads must request READ, WRITE and DELETE sharing on their first open, allowing
the existing atomic Rename publication contract. Other platforms retain their
existing read operation. Do not catch a sharing error and retry, relax strict
nonce/schema/timing admission, change the hold or recovery budget, or replace
the receipt. The orphan-runner acknowledgement wait must also observe that
exact runner's completion and report an early exit at its named phase rather
than wait out the deadline. Existing guard/controller release ownership remains.

Prove the Windows contract with an actual DELETE-access/full-sharing handle:
the old reader must fail and the new single-open reader must read the exact
strict receipt. Invalid content remains rejected. Prove early child exit is
reported without losing its original failure. Then freeze a new identity and
repeat both native safety preflights and all three business profiles. A pass
from the historical short/long cases cannot approve the failed aggregate or
replace the still-pending crash, 8h and native interaction gates.

### D29 — Both endpoints retain the exact predecessor's recovery window

The sealed D28 flap proof shows that candidate promotion, not a browser deadline,
detached the original WebSocket while its predecessor was still inside the
existing ICE grace window. The underlying reason that the old ICE stream stopped
responding is not yet proven: packet captures show requests reaching the Mac
interface while the opposite direction continues exchanging STUN. Interface
receipt is not proof of socket delivery or STUN authentication.

For a grace-recovery candidate, both endpoints must wait before their first
Ready dispatch, after establishment/probe but before stopping the existing early
decision observer. That observer and the existing renewal worker retain their
ownership while waiting. Match the exact predecessor pointer and signed previous
attempt/generation, directed user/network/device scope, current candidate slot,
account, pin and registration/core fences. A mismatch is a typed refusal, never
permission to substitute a predecessor or bypass the gate.

Only an actual predecessor context/transport termination releases this gate.
Current Ready recovery cancels the still-uncommitted candidate instead. A cleared
graceTimer or a non-ready snapshot alone is not terminal proof. Keep the existing
single transport observer and use closed cancellation/termination broadcasts;
do not add a competing consumer to Transport.Changes or session.changed. The
observer must publish exact-candidate cancellation even when a coalesced recovery
arrives before the public projection ever became suspended. Recheck ownership at
wake and immediately before source commit dispatch. A dispatched or verified
committed decision retains the existing durable-resolution authority and cannot
be rolled back.

Do not gate an explicit remote-core replacement or a transport-only/refused
primary's workbench upgrade: those are not recovery of an existing usable
workbench. Keep the original 20s grace, 25s business criterion, signed ticket,
120s preparation deadline and capped lease renewals. Expired/cancelled candidates
fail under their original authority; waiting does not extend or recreate them.
Prove both-end Ready/Commit exclusion, original mux/WS survival, coalesced wake,
recovery/expiry/dispatch races, stale scope and the two excluded paths before a
new physical source freeze. The failed D28 aggregate remains failed.

### D30 — Preserve shutdown and bootstrap first causes

Quality run 39403408877 failed while stopping the real coordinator during the
certificate lifecycle test. The fixture's whole-process 5s guard starts before
the server's separate 5s HTTP drain, followed by additional unjoined cleanup.
This is a confirmed budget incompatibility, not proof of the actual stalled
phase. Neither generic WebSocket presence nor infrastructure flakiness explains
the failure without a phase receipt.

Add bounded credential-free lifecycle receipts for stop request, signal result,
HTTP drain, control/hub/listener shutdown, process Wait/copier completion and
forced cleanup. Preserve signal/Wait errors and stop the test at a failed graceful
boundary instead of mutating the certificate database and restarting afterward.
Retain the unchanged 5s fixture guard. In the independent server's existing
planning owner, first reproduce incomplete HTTP-header and already-closing socket
boundaries with deterministic barriers; fix the proven owner rather than merely
changing a timeout constant or widening the test guard. Any production server
change requires its own race suite, independent review, explicit CI pin and
verified deployment; no live restart is authorized by a diagnostic alone.

D28 also failed before fault injection in two independent phases: a Windows DSH
child stayed starting with zero observed output, and an initial ICE connection
never selected a path. Preserve those as separate failures. Add bounded stream
termination/launch-stage facts and initial-barrier scoped diagnostics without raw
credentials, arbitrary stderr, process adoption, retries or deadline extension.
An EOF receipt cannot establish why Node did not publish its URL, and a network
interface capture cannot establish delivery to Pion's ICE worker.

Program-pause exits must also retain a bounded stack before owned process
cleanup, including an unexpected original-WS EOF during injection. Observe only
after the original assertion has failed, using an independent at-most-10s window
and the exact last-observed directed scope, or explicit unknown. Do not repeat the
existing 45s deadline observer, consume another owner's event stream, or count
diagnostic time as acceptance. Unknown attempt scope cannot dispatch Entry.

### D31 — Preserve the new physical initial-ICE failure

At exact client `4848983` / source digest `b49a53b2…` and independent server
`9665b122`, both exact-SHA GitHub CI workflows and the six local joint integration
groups passed. The single physical program run nevertheless remains FAIL: short
3s and long 35s pauses recovered in 766ms and 1000ms respectively, but the flap
profile failed its original 25s initial-transport barrier before fault injection.
Only the short profile preserved the original WS; the long profile used automatic
WS replacement while retaining its application identity. Neither proves eight
hours, core-crash or native interaction acceptance.

The retained dual captures show two initial ordinary IPv4 STUN requests receiving
success responses on the same tuple, followed by a third unanswered ordinary
request and 129 unanswered nominations over 24.446s at the Mac interface. The
27 matching Windows nominations have identical captured IPv4/STUN bytes and valid
captured checksums on both hosts. USERNAME hashes reverse consistently; MI is
unknown without the key. The Mac all-goroutine snapshot has an idle Agent task
loop and 19 UDP readers, but cannot associate one reader with the failing port.
Do not infer socket delivery, checksum failure, MI refusal or a task-loop deadlock
from these observations. The existing capture excludes ICMP4. All original
failed logs, packet files and capture-preservation guard failures remain retained.

### D32 — Diagnostic-only socket-chain observation

Before changing transport behavior, use a separately identified Go build overlay
that replaces only the application's SettingEngine construction and adds an
observer. Do not edit production source or the pinned Pion module cache. The
overlay must wrap the actual stdnet sockets, retain the UDP AddrPort fast path,
and return every underlying read/write/deadline/close result unchanged. It must
not retry, swallow errors, add deadlines, change interfaces or select IPv4/relay.

Record bounded credential-free PID/socket/handle/local and remote endpoint,
attempt/generation, STUN transaction/class/nomination and actual read/write results.
Never record payloads, SDP, USERNAME, passwords or raw error sentences. A fixed
BindingRequest callback returning false supplies positive evidence of Pion's
admission and response-send path only; its absence is unknown, not proof of MI
failure. Negative logger facts remain PC-scoped unless the source supplies a txid.
Use nonblocking bounded queues outside task-loop I/O, count all drops and refuse
complete-evidence claims on overflow or failed output. Join each observer only
after its actual PC cleanup, including construction failure paths.

Keep overlay, helper, private runner and original source hashes in the new run's
manifest. Label every result diagnostic-only and explicitly false for release,
eight-hour and installed-app acceptance. Collect the exact owned Windows logs
before removing that unique test directory; preserve the original failure before
cleanup. Pure/real-loopback tests and independent review precede a single new
physical diagnostic; no automatic retry-to-green is allowed.

### D33 — Read-only exact-socket receive-queue boundary

D32's first short failure proves successful interface receipt without a return
from the same actual Go UDP read for 26.208s. Two earlier nominations were admitted
by Pion but their responses failed with Darwin errno 65. Other attempts show that
errno 65 can be followed by successful same-socket I/O, so it is not sufficient to
identify the root cause. Preserve all D32 failures and incomplete successor/long
traces; do not relabel them after another diagnostic.

Use a new ignored diagnostic overlay, never modify the frozen D32 files or the
production/Pion source. At most once per second per socket, query only the owned
UDP connection through its RawConn.Control callback. Keep the fd use inside that
callback. Darwin SO_NREAD is the head datagram's data length, SO_NUMRCVPKT is the
queued datagram count and SO_RCVBUF is capacity; they are distinct non-atomic
getter observations, not a single queue snapshot. Record per-field validity,
typed errno, exact socket/attempt/generation, sampling interval and read-call
in-flight/last-return facts. A query error is unknown/incomplete, never zero.
Windows is explicitly unsupported for these Darwin fields, not silently mapped
to another mechanism. Never query SO_ERROR, consume/peek a datagram, change a
deadline, register poll events, retry I/O or change network/permission policy.

One bounded observer-owned sampler runs outside Pion's task loop and original
I/O calls. Stop and join it before writer drain/summary/flush on every cleanup
path. Getters may take kernel locks/hooks: this is diagnostic instrumentation,
not a zero-perturbation production acceptance build. Continuous queued packets
with a pending read establish a socket backlog, not by themselves a lost-wakeup
root cause. An empty sampled queue does not prove a privacy denial or exclude
packets between samples. Correlate with preserved packet and goroutine evidence.

Prove real zero/nonzero UDP datagram non-consumption, fd/close ownership, explicit
unsupported/error handling, bounded collection and sampler shutdown under races.
Freeze distinct helper/operator/build identities and independently review before
one new physical diagnostic. It cannot pass the production, eight-hour or native
gates. A failed diagnostic ends and is sealed; no automatic repeat-to-green.

## Risks / Trade-offs

- Runtime refusal could cause repeated workbench requests → keep existing backoff
  and terminal admission; never silently change the requested runtime.
- Concurrent replacements could detach a successor → ownership fencing and race
  tests cover stale completion, cleanup, and opposite-direction activity.
- Cached main entries could hide revocation → authoritative readback and pre/post
  authorization checks, not generation relabeling.
- Installed cores lack the fix → isolated candidates prove source behavior;
  current installed applications remain unchanged until explicitly updated.

## Migration Plan

Client credentials and saved connection records do not migrate. The server adds
schema 7 under D14, before verified control-v2 clients are tested against it.
Preserve identities and old failure evidence; never automatically switch to v1,
relay, IPv4-only or a replacement runtime. Run release source/package gates on
the final frozen source. The user requested the stable GitHub release next so
they can install and validate it; physical long-duration and installed-UI gates
remain separate and must not be represented as passed. The disabled-firewall
UDP profile remains failed historical evidence; D19 records the user's explicit
program-unresponsiveness replacement. It cannot be relabeled as a successful
UDP experiment or waive the eight-hour gate.

### D35 — Authenticated network membership converges without user refresh

Confirming the persisted/current account is the synchronization boundary. After
a successful login/registration the renderer immediately requests that
confirmation without delaying the visible signed-in state. After the exact
account session is verified, the client repairs its coordinator WSS registration
and idempotently adopts the device's already-authorized network memberships.
This also runs for persisted-session confirmation, including when the launcher
reconnects to an already-running core; it does not select a network, create a
membership, or replace a saved per-computer network choice.

After adoption commits, the independent coordinator republishes the source
device's current authenticated registration to online devices authorized by an
active shared network. The event uses the existing control-v2 peer-registration
contract. A recipient validates the current account and selected session before
refreshing the peer catalog and device directory, then notifies the renderer to
refresh open network-choice views. The peer receive loop only schedules bounded
work. If a recipient was offline, its own next confirmed account read performs
the same idempotent synchronization; a missed transient event is not treated as
revocation or repaired by a guessed network.

Any rejected adoption, WSS repair, selected-session fence, or authoritative read
remains an explicit error. The client never silently chooses another network,
deletes a pair, rewrites credentials, or reports a current directory from a
failed read. Existing device identity, network membership and pair rows are
preserved.

### D36 — Fresh original authority repairs a locally revoked saved choice

The installed Windows client retained a revoked Mac catalog row while the
coordinator still reported the original network and pair active and both devices
online. The peer's authenticated candidate reached Windows, but the absent live
pin produced `p2p.pair_unauthorized`. D35's membership synchronization could not
repair this row because D18 treated its local revoked flag as a permanent demand
for manual reselection, even after the original authority was freshly confirmed.

The current server authority owns authorization. On the existing automatic
catalog synchronization path, admit the saved original network when a fresh
selected-account network/pair/identity read proves active authority with the same
service, user, local and remote device IDs, and both public keys. A local revoked
flag alone cannot require user selection. Do not select a different network,
adopt a changed device/key, or substitute cached authorization. An actually
revoked/missing original network or pair, foreign account, identity mismatch,
failed read, or superseded selected session remains refused or stale; first-time
multiple-network ambiguity still requires explicit selection.

Use the existing catalog owner and atomic `CommitTransitions` CAS to retire the
revoked row and publish the newly confirmed active row without exposing an
intermediate deletion. Preserve selected-session and registration fences before
publication and candidate activation. Only after durable exact recovery may its
own engine intent be reauthorized; repeated synchronization of an already active
choice without a recoverable authorization refusal is idempotent and cannot reset
unrelated terminal refusals or in-flight epochs. The same fresh exact scope may
also repair an authorization refusal left by missing old local admission; this
is limited to `p2p.pair_unauthorized`, `p2p.pair_revoked`, `p2p.pair_not_found`
and `p2p.network_revoked`. Identity/trust/lease/device authorization, runtime,
transport and unrelated terminal failures are not cleared. The engine checks and
resets its current exact intent under one lock, so a newer non-authorization
failure cannot be cleared by an earlier qualifying observation.
Use the existing production reconciliation owner to resume connection,
not a parallel Connect, runtime-start request, new IPC operation, schema, timeout,
quota or server-side pair mutation.

The existing named `pairs.network_choices` boundary must not expose a recovered
`selected` projection ahead of its authority. Every successful choice read first
passes the fresh catalog CAS and live-pin publication, then returns `selected`
with the resulting catalog revision. An unchanged record is a no-op CAS without
a file write or revision change; it still reinstalls a missing live pin after a
lost publication reply, even when there is no terminal refusal to trigger repair.
If publication fails, preserve the explicit refusal instead of a selected
projection backed only by memory. An ordinary unchanged choice read does not
switch networks or reset engine epochs.

Prove the regression from revoked durable row to active readback without
`pairs.select_network`, repeat and restart behavior, failed publication/read and
scope-change refusal, unchanged alternate-network ambiguity, and exact terminal
isolation with focused races and a real isolated coordinator/helper integration.
Source validation does not update installed clients or complete physical
Mac/Windows, eight-hour, native UI or release acceptance.

### D37 — Keep Windows local runtime commands in the background

The user reported a Windows console window appearing when starting local DSH.
The Go runtime owner started the supervised console program without explicit
window suppression, and port inspection and process-tree termination also
launched console tools through their own command constructors. These commands
are background implementation work; the Launcher Console owns their visible
process output and an additional native console window is not a product action.

On Windows, the supervised runtime child uses `HideWindow` together with
`CREATE_NO_WINDOW`. A shared platform-owned `backgroundCommand` constructor
applies the same attributes to the port inspection commands and `taskkill`.
Keep the original executable/arguments, command results and typed errors. Do not
add a shell wrapper, change the user's terminal or hide an explicitly requested
interactive application. On non-Windows platforms this constructor remains
ordinary `exec.Command`; the supervised runtime still leads its existing POSIX
process group.

Window suppression must retain stdout/stderr pipes, URL readiness announcement,
exit/wait receipts, Console/log output and existing launch/Stop behavior. The
independent runtime owner's authenticated attachment, detachment and survival
contracts remain unchanged. Preserve the current Windows tree-termination flags
and POSIX process-group signaling. This is limited to local harnessruntime
process construction; SSH commands and other product domains are out of scope.

Verify Windows process attributes and actual background command execution with
output/exit readback, the real native no-console child path, port inspection and
Stop behavior, plus the existing owner/pipe lifecycle checks. Cross-build the
non-Windows implementation without changing its process-group contract. Record
source/native proof separately from installed-app verification; do not relabel
section 6.4's retained broad failures or the physical ICE gates.

### D38 — Preserve explicit workbench intent behind background preparation

The installed 0.1.94 Run page can report `p2p.connection_busy` while the original
network is active. Electron first wakes background retries twice, then dispatches
the explicit connection. A background bind-only candidate can already own the
only outbound slot; rejection occurs before accepting the user's cold-start
intent. Its pre-ticket reservation has no public State until transport creation.
The renderer also retains one global refusal after successful reads, so a past
busy code can outlive the request and appear on another computer.

Remove both Electron pre-connect retry wakes. The existing Go `peer.connect`
boundary already repairs the exact account's signal subscription. Keep one
explicit dispatch and retain strict reply pair/generation validation. Normal
maintenance continues to own background retries.

When an explicit workbench request meets a background bind/resume candidate,
the Go manager may register one exact waiting owner for that pair. It preserves
the existing candidate, ticket, negotiation and prepare-resolution lifetime.
Waiting does not upgrade that candidate's permissions or cancel it when the
caller leaves. A successful borrowed candidate must be promoted out of the slot;
a failed candidate must finish its exact cleanup. Never wait for a healthy
promoted primary's lifetime `done`. Only then reserve a new candidate with the
explicit request's own generation and cold-start intent. An existing explicit
candidate remains single-flight; no second explicit waiter or fabricated old
generation response is admitted.

Capture and revalidate the manager, selected account, exact pin/device/key scope,
signal owner/subscription and registration fence. The waiting owner's per-pair
cancellation epoch and new reservation share the manager lock. Disconnect clears
that ownership atomically before cleanup; a late waiter cannot restore the
cancelled intent. Revocation, account/fence changes, stale generation and shutdown
remain typed refusals. The waiting owner has priority over a new background
reservation but cannot displace an already admitted candidate.

Initialize a pre-ticket candidate's public in-flight state from its actual
Prepare attempt ID and generation. Current-state ownership must recognize that
reservation without claiming a ticket, workbench, path or Ready. Preserve an
existing primary's projection until authoritative promotion. Preparation
diagnostics record only bounded phase, identity/fence, classified error and
ownership fields; no tokens, keys, tickets, payloads or arbitrary error text.

Unknown prepare replies retain the exact immutable attempt. A new, explicit
rate-limit refusal followed by same-scope authoritative absence may return to
the engine's existing backoff only when this attempt has never had an ambiguous
dispatch result. Earlier lost, decoder or transport results remain sticky:
a later 429 plus temporary absence cannot erase them. No caller timeout,
counter reset or new arbitrary deadline proves server non-admission.

Renderer refusals belong to an exact service/pair operation. A current peer
readback replaces a historical busy hint with its actual stage/error, while
unrelated computer and real refusal records remain isolated. Close the accepted
reply/late-callback readback gap using the existing typed state ownership; do not
invent Ready from dispatch, poll indefinitely without an in-flight owner, replay
renderer IPC IDs or add a parallel connection controller.

Verify duplicate wake removal, delayed state publication, per-pair refusal
isolation, background/manual interleavings, caller cancellation, disconnect's
reservation barrier, stale scope/generation, exact unknown prepare retention,
safe rate-limit backoff and no implicit runtime start from background recovery.
Exercise a real coordinator and the actual public Run control separately from
unit cases; retain source, installed artifact, native interaction and physical
cross-machine outcomes as distinct evidence.

### D39 — One account authority for the footer and account panel

The user observed the Mac footer reporting online while Account and Network
reported signed out, then explicitly requested one consistent state, including
signed out when no valid account session exists. A running core, reachable
coordinator, device certificate or transport is not proof of a signed-in user.

The footer and Account and Network panel consume the same selected service's
account-domain session state. An unread/restoring session stays pending; an
authoritatively absent/expired session is signed out on both surfaces. Only a
confirmed current user grants signed-in presentation. Signing in, registration,
logout and session invalidation update that shared state; a late old read cannot
replace a newer login/logout outcome or another service's identity. Preserve
explicit failed/unknown reads rather than substituting connectivity as authority.

A later non-authentication refresh failure does not revoke an already confirmed
signed-in session in the same revision. Retain that exact accepted state through
rate limiting, helper admission refusal or network-read failure. This cannot
promote an initially unknown state or a historical identity into signed-in
authority; explicit no-session replies, logout and epoch changes retain their
existing invalidation rules.

Keep network transport reachability separate from account authentication. If
reachability is still presented, label it explicitly without allowing an online
transport to override signed-out or pending authentication. Reuse existing typed
account readback and locale dictionaries; no new credential exposure or arbitrary
renderer capability is needed. Do not relogin, reset credentials, change networks
or restart processes to manufacture consistent presentation.

Verify selected-service isolation, startup restore, missing session, successful
login, logout, failed reads and stale asynchronous results. Compare the footer
and account card from the same live domain through public UI controls, and keep
this visual/account-state evidence separate from physical transport readiness.


### D40 — Isolate test distribution and contain runtime-owner failure

The user explicitly authorizes a hotfix after the formal 0.1.95 installation was
blocked by a test installation's owner record. The test copy had reused the
formal profile. Stable distributions preserve the existing formal profile and
credential/catalog identities. Development and non-tag test distributions have
a distinct application/installer identity and require an explicit absolute test
profile root, disjoint from the formal profile. Selection happens before the
single-instance lock, logs, bootstrap, credential access and core creation.
Unknown distribution metadata, missing/relative/linked/conflicting test roots
fail explicitly; they never fall back to the formal home. An explicit test root
may also isolate a stable artifact for validation. Test native DSH home, Electron
user/session data, bootstrap, managed roots, catalogs and runtime state all stay
inside that isolated profile. Test installation cannot terminate or replace the
formal installation through the shared installer identity.

Admission also reads the formal bootstrap locator and validated root registry
without writing them. A test root must not overlap any registered external
settings, managed root or workspace; unreadable registration fails closed for
test admission. Native credentials use a stable explicit namespace derived from
the canonical test root on all platforms. Stable uses its original native key
identity and ignores an inherited test namespace. Test missing secrets never
read, migrate or delete stable entries. Isolated profiles cannot query, enable
or disable the global stable autostart registration, and their core startup is
independent of that registration. Real macOS Keychain and Linux Secret Service
namespace read/write/delete checks are required in the native packaging gates.

D12's strict owner record and authentication contract remains. A failed owner
Open is a real unavailable runtime authority, not a replacement supervisor or an
empty successful runtime. Both desktop and headless compositions continue to
serve unrelated catalog, root, credential, SSH and device/account/P2P operations;
all local runtime operations preserve the original typed owner refusal. Only a
successfully opened owner participates in cleanup. Orderly desktop shutdown
allows the already documented sequential broker and owner cleanup budgets before
forced termination; normal closure must join its actual owner and remove its
record. Corrupt, incompatible and unreachable ownership is never silently
replaced, and retained owner evidence remains unchanged.

The current abandoned Windows record has a separately authorized operator
recovery: securely back up existing formal records on the data drive, normally
close the formal application, verify the exact old owner is absent and no managed
local DSH process remains, and quarantine only that stale runtime-owner record.
This is explicit incident recovery, not an automatic product takeover policy.
Account credentials, registered roots, server/network/device/key/pair identities
and SSH computer records are preserved and read back after recovery. Retire the
old unisolated test installation so it cannot write formal state again.

Verification covers fresh/same-root/no-op, rejected root/channel, partial boot,
identity mismatch, dead/corrupt owner, repeated/restarted core and graceful
cleanup using real production compositions and disposable test roots. Before
publication, exercise the formal application's public controls for restored
sign-in, its existing SSH computer and original LAN/P2P computer with loaded
workbench content. Source gates, independent review, exact native package and
same-source CI are required. Preserve earlier native frame and eight-hour
limitations; this hotfix is not acceptance of those unrelated long-duration gates.

### D41 — Reconcile a committed login whose reply was not confirmed

Formal diagnosis established that the original session expired, then the user's
new login succeeded and persisted a valid session for the original account.
The renderer still offered sign-in; a repeated submission received the main
owner's `p2p.user_already_logged_in`. The exact cause of the first unaccepted
reply was not captured and is not inferred from that symptom.

A login result classified as unconfirmed, or that exact already-signed-in
refusal, must initiate one normal server-backed current-user read. Neither
refusal itself proves an identity or successful authentication. A successful
read updates the existing shared account projection; authoritative sign-out
and transient/unknown results preserve their normal semantics. Do not resend
passwords, delete credentials, log out, select networks or change pairings.
Revision, stop, service-switch and explicit sign-out fences apply to the login
reply and the recovery read so late work cannot restore abandoned authority.
