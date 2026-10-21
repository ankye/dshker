## Purpose

Keep explicitly opened remote DSH workbenches usable after temporary network
loss, while preserving device authorization, browser isolation, and the distinction
between background transport connections and a user-requested workbench.

## ADDED Requirements

### Requirement: Footer and account panel share selected-account authentication

The Launcher SHALL derive both footer and Account and Network authentication
presentation from the same selected service's current account session. Transport
availability SHALL NOT establish or retain signed-in presentation.

#### Scenario: Core is reachable without a user session

- **WHEN** the core or coordinator is online but the selected service has no valid user session
- **THEN** both surfaces show signed out and neither reports account online from transport state

#### Scenario: Account restoration has not settled

- **WHEN** the selected service's current account is still unread or restoring
- **THEN** both surfaces retain a pending state without inventing a signed-in or signed-out result

#### Scenario: Login or logout overtakes an older read

- **WHEN** a confirmed login, logout or session invalidation supersedes an older current-user read
- **THEN** both surfaces reflect the current operation's account state and the late read cannot restore old authority

#### Scenario: A different service is selected

- **WHEN** the selected service changes while another service's account request is pending
- **THEN** footer and account panel both reflect only the newly selected service's authentication

### Requirement: Retain explicit account transport ownership during recovery

Ordinary Bearer management and directory operations SHALL use the exact existing
device mTLS transport after the account enters its device-bound phase. Pre-device
setup SHALL be explicit. Missing/expired device transport and closed accounts
SHALL refuse, not silently retry through a public client. Named authentication
confirmation/revocation SHALL preselect public transport only for explicit setup
or a fully validated expired original identity, and exact device mTLS for a valid
original identity. Login and certificate recovery SHALL retain their existing
public contracts. None SHALL require an unexpired device to recover an expired one.

#### Scenario: Two restored devices share an IP

- **WHEN** both current devices refresh selected-account directories while establishing candidate connections
- **THEN** ordinary account requests SHALL carry each original device TLS identity and the real selected Bearer session
- **AND** no owner-account substitution, increased admission limits or extra public retry SHALL occur

#### Scenario: The device certificate needs recovery

- **WHEN** a bound device's ordinary account transport has expired
- **THEN** ordinary requests SHALL fail with a typed recovery refusal
- **AND** only the named public authentication and certificate-recovery owners may establish fresh authority, without an mTLS dependency cycle

#### Scenario: A valid original device confirms the selected account

- **WHEN** user.current, user.logout, selectedAccount or confirmLogin dispatches a fresh authenticated request from a valid original device
- **THEN** the exact original device mTLS client and actual Bearer session SHALL identify that one request without requiring WSS or candidate activation
- **AND** an existing validated recovery-pending owner SHALL remain pending even if issuance has made its certificate valid, until same-Manager restore completes its activation barriers
- **AND** missing identity, failed TLS, HTTP refusal or an expiry race SHALL NOT cause a second public request or certificate-owner substitution

#### Scenario: A legacy expired device has no recorded recovery network

- **WHEN** main requests the named device.certificate_recovery_scope operation with its exact original device and current durable token
- **THEN** a read-only recovery owner SHALL return fresh user and authorized network members using explicit public authentication reads, without ordinary-directory caching or a device-mTLS dependency
- **AND** main SHALL require that fresh user's explicit remembered network and exact original-device membership, rechecking caller, token, service, credential and selection lifetimes before issuance
- **AND** missing choices, changed authority and malformed or duplicate projections SHALL refuse without network inference or public retry of an ordinary method

#### Scenario: Login confirmation occurs after the original device expires

- **WHEN** a real login or persisted-session confirmation succeeds while the exact bound original certificate is expired
- **THEN** public authentication confirmation SHALL publish the actual user/session without requiring WSS or directory activation
- **AND** device activation SHALL remain explicitly recovery-pending, with old-account scope fenced and the old signaling supervisor detached, never reported as ready
- **AND** the same account SHALL retain its existing workbench intent/gateway for recovery, while logout or an account change SHALL clear the old scope
- **AND** public logout SHALL revoke the actual Bearer even though ordinary device requests are refused; fresh certificate issuance alone SHALL NOT complete the device activation barrier

#### Scenario: The original certificate expires during a successful auth request

- **WHEN** real login, current-user confirmation or logout succeeds after its original device crosses NotAfter during the request
- **THEN** post-auth admission SHALL freshly validate the same identity and explicitly enter recovery-pending without synchronous WSS/catalog activation
- **AND** the actual confirmed user/session/revocation SHALL be returned without reusing a stale pre-auth activation decision or catching activation failures as success

#### Scenario: Logout loses its caller or original credential during HTTP

- **WHEN** the actual logout is in flight and cancellation, credential changes or durable deletion failure prevents complete confirmation
- **THEN** the existing local old-account authority SHALL still be fenced and joined without requiring new identity validation or a live caller context
- **AND** the actual remote/validation/deletion failure SHALL remain visible; no unverified pending provenance, replacement HTTP request or fabricated remote revocation SHALL be created

#### Scenario: Stale logout races new activation or failed durable deletion

- **WHEN** logout input does not belong to the current captured session, or a new session's activation replaces the old one
- **THEN** that request SHALL NOT cancel the replacement bootstrap owner or mutate its generation
- **AND** an admitted old-owner logout SHALL invalidate its queued and future automatic bootstrap even when durable deletion fails, without retaining raw-token history or introducing another persisted schema
- **AND** old-session absence alone SHALL NOT be mistaken for a replacement owner or skip captured local cleanup

#### Scenario: Logout fails remotely and durable deletion also fails

- **WHEN** the old token remains valid remotely and durably stored after local logout has revoked its exact session owner
- **THEN** later current-user confirmation, device restore and headless bootstrap SHALL refuse that old owner without resetting revocation through a worker-generation change
- **AND** failed login SHALL NOT reset it; only a genuinely new successfully published session may own new authority, with independent strict job/logout generation fences preserved

### Requirement: Keep canonical certificate proof operation-owned

Restore owner resolution and immediately following preparation SHALL share one
fresh canonical certificate query inside that exact original-device restore
operation, retaining all service/key/certificate/account/lifecycle validation.
Independent operations SHALL obtain fresh proof, and certificate issuance or
recovery mutation SHALL retain separate authoritative readback. The operation
SHALL NOT cache completed authorization or remove fresh CurrentUser checks.

#### Scenario: A stored device is restored under production limits

- **WHEN** one admitted restore resolves and prepares its original canonical certificate
- **THEN** that operation SHALL perform one canonical query, retain both fresh selected-account confirmations and verify original identity before publication
- **AND** a concurrent or later independent operation SHALL NOT reuse its completed proof

#### Scenario: Authority changes while canonical proof is in flight

- **WHEN** logout, session/device replacement, generation change, cancellation or Close supersedes the original restore
- **THEN** the old result SHALL refuse without publishing new authority or switching transports
- **AND** a post-issuance authoritative readback SHALL NOT be skipped or mistaken for the initial query

### Requirement: Preserve authority while admission is throttled
Candidate operations SHALL resolve/replay the exact known attempt and ticket
after transient throttling or invalid action readback without releasing unknown
authority, inventing success or extending its deadlines. Host SHALL own a single
cancellable/joined transient bootstrap retry per service before Manager creation
and before candidate activation. It SHALL revalidate original device, selected
session, service/catalog and account/removal fences on each retry.

#### Scenario: Cold startup is throttled before a Manager exists
- **WHEN** the real coordinator refuses startup temporarily with rate_limited or another explicitly transient bootstrap error
- **THEN** the existing lifecycle owner SHALL retry the same stored authority with bounded backoff without login, enrollment or runtime start
- **AND** forgetting the service or changing accounts SHALL cancel and join stale work without restoring it from retained credentials

#### Scenario: A candidate action or its cleanup is throttled
- **WHEN** Ready, commit, cancellation or End cannot be confirmed
- **THEN** exact owner-held decision/cleanup responsibility SHALL survive local request cancellation and broken-carrier cleanup
- **AND** malformed replies SHALL NOT be treated as a cancellation or readiness receipt
- **AND** the original attempt, ticket, deadlines, grace and physical recovery clock SHALL remain unchanged

### Requirement: Hand off candidate decision ownership exactly once

The early candidate observer SHALL be stopped and joined before the Ready,
resolve or cancel phase takes over, including failure/cancellation paths. Its
dispatched unknown mutations SHALL remain owned and authoritatively resolved.
A same-call fully validated Ready receipt MAY supply the resolver's initial
one-use result, without caching current-active authority or changing deadlines.

#### Scenario: Candidate Ready already returned a verified decision

- **WHEN** the exact admitted candidate proceeds from successful Ready to resolution
- **THEN** the early observer SHALL no longer issue overlapping State requests and the verified same-call receipt SHALL be consumed once
- **AND** promotion SHALL still require exact current active ownership, both Ready records, current scope and a valid lease

#### Scenario: Candidate action completion is unknown

- **WHEN** a Ready, Commit or Cancel reply is lost, malformed or throttled during phase handoff
- **THEN** exact-ticket durable State resolution SHALL remain mandatory and the unique candidate slot SHALL stay owned
- **AND** no old receipt, stopped observer, new attempt or changed timeout SHALL substitute for authoritative completion

### Requirement: Carry selected-session denial through every authority tail

Authentication activation SHALL carry the exact captured selected-session scope,
as SHALL restore, local catalog/pins, directory publication and named recovery
authorization across awaits. Locally revoked selected-session authority SHALL NOT
be reacquired from a still-valid remote/durable token. The scope SHALL NOT cache
remote authorization or replace ordinary explicit caller-Bearer data-read semantics.

#### Scenario: Logout wins before a pending authority read publishes

- **WHEN** an exact old-session catalog/network/directory/recovery read is pending and actual logout locally revokes its owner while remote logout or durable deletion fails
- **THEN** the pending result SHALL refuse before publishing new pins, activation, a directory view or issuance authorization
- **AND** background/AfterWrite work SHALL retain the same selected owner, rather than recapturing a newer login after its await

#### Scenario: Worker generation changes without changing session identity

- **WHEN** a request or bootstrap's strict typed generation/job fence is replaced after its earlier guard passed
- **THEN** its synchronous commit SHALL still refuse even if the session owner itself is unchanged
- **AND** ordinary background work SHALL remain independent of unrelated worker generations while still rejecting logout, service removal and selected-owner replacement

#### Scenario: Genuine new authentication or explicit signed-out restore

- **WHEN** actual login/register durably publishes a genuine new session, or explicit empty-account restore proves durable absence successfully
- **THEN** the new session SHALL obtain its own scope without inheriting old-account revocation, while signed-out restore SHALL remain empty-account/read-only
- **AND** provider errors, corruption, expiry and missing arguments SHALL never be interpreted as absence or new authentication

### Requirement: Current-account pair identity precedes candidate capability
Production restore SHALL accept only an empty initial pins list. It SHALL register
the selected login under v2 with an explicit empty capability list, read fresh
pair identity through `POST /v2/pairs/identity` using current registration,
userId, networkId and the explicit pair record ID, then advertise candidate
capability only after scoped live pins and catalog admission complete.
Account changes SHALL repeat this barrier without changing enrollment identity.
The client SHALL NOT obtain v2 identity from v1 routes or cached catalog rows.

#### Scenario: A device enrolled under one account selects another bound account
- **WHEN** devices enrolled under account A are bound to a network owned by B and both select B
- **THEN** fresh v2 identity SHALL retain their device IDs and keys and identify B as the business account
- **AND** Pin and prepare SHALL use B while Device.UserID and certificates remain unchanged
- **AND** early prepare before fresh pin completion SHALL be refused by explicit capability admission

#### Scenario: Scope changes while an identity read is pending
- **WHEN** the current registration or selected account changes before a scoped identity reply is admitted
- **THEN** the client SHALL reject the stale reply without publishing a usable catalog entry
- **AND** missing or refused fresh identity SHALL NOT be replaced by cached or legacy identity

### Requirement: Preserve primary authority during verified candidate recovery

A transiently disconnected primary SHALL immediately report suspended rather
than ready. Automatic recovery SHALL retain its gateway, explicit workbench intent
and original runtime while preparing at most one candidate per directed link.
Missing control-v2 capability SHALL be refused, not downgraded to a destructive
legacy reconnect. Recovery SHALL NOT wait for grace expiry before it can prepare
a candidate, and SHALL NOT change ICE timeouts or the twenty-second grace.

#### Scenario: Original transport recovers before commit dispatch or cancel wins

- **WHEN** the old transport recovers before commit dispatch, or exact cancel
  wins the coordinator decision CAS
- **THEN** the original WebSocket and ready primary remain usable
- **AND** the exact candidate is authoritatively cancelled without losing an
  in-flight prepare or allowing a second concurrent candidate

#### Scenario: Verified candidate replaces a suspended primary

- **WHEN** candidate runtime resume and candidate-specific authenticated HTTP
  and WebSocket verification succeed and the coordinator commits that candidate
- **THEN** the original stable gateway admits the verified replacement
- **AND** only old-carrier connections are retired; new-carrier connections,
  opposite-direction work, credentials and runtime launch identity remain intact

### Requirement: Resolve ambiguous control outcomes authoritatively

Prepare SHALL be idempotent for a client-generated attempt ID and exact immutable
business request, while independently admitting each call's current registration.
Candidate resources SHALL outlive a failed HTTP request until an authoritative
terminal decision is known. A dispatched commit SHALL never be assumed cancelled
because of timeout, local cancellation or recovery of the previous transport.
State readback SHALL distinguish a committed historical decision from the
currently active attempt. Explicit disconnect and revoked authorization SHALL
clear both primary and candidate; natural old-carrier expiry SHALL NOT do so.

#### Scenario: Commit response is lost

- **WHEN** commit succeeds on the coordinator but its response is lost
- **THEN** the client keeps the candidate in resolving and queries the exact
  decision without starting a new attempt or rolling authority back
- **AND** it promotes only when that committed candidate is still current

#### Scenario: Late old attempt cleanup races with successor

- **WHEN** an old attempt's error, timer or cleanup completes after promotion
- **THEN** it cannot detach the successor or report the old state as current

### Requirement: Wake recovery from authenticated state changes

Transport and current peer-registration changes SHALL promptly wake scoped
production reconciliation, without doing network work in transport callbacks.
Stored ready stage SHALL NOT satisfy entry readiness when the carrier is suspended.
Ready-to-suspended-to-ready within one attempt SHALL be admitted explicitly and
SHALL NOT be mislabeled a terminal disconnected-to-ready transition.

#### Scenario: Peer core restarts while its independent DSH owner stays alive

- **WHEN** that same enrolled device announces its new authenticated core
  registration and the original runtime is still running
- **THEN** the surviving peer automatically prepares recovery without waiting
  for a five-second periodic sweep or starting DSH
- **AND** original business readback must meet the existing twenty-five-second
  budget; a late diagnostic ready does not count as success

### Requirement: Restore explicit selected-account authority

Device enrollment owner SHALL NOT substitute for the selected login. Restore
SHALL carry the selected account separately from immutable device identity and
revalidate a stored login through the coordinator before publishing its authority.
Temporary read/transport failures SHALL preserve the stored session and fail
explicitly rather than sign out or select another account. Explicit logout SHALL
clear stored login authority and end both old-scope connection slots.

#### Scenario: Signed-in device core restarts

- **WHEN** a core restarts with the original valid persisted login
- **THEN** it reads and verifies that login itself before v2 registration, without
  another password, manual user.current call or inferred certificate-owner login

#### Scenario: Selected account is absent, unlinked or unreadable

- **WHEN** no login exists, its device membership is missing, or an account read fails
- **THEN** absence remains explicitly signed out, while failed reads and missing
  membership are distinct refusals; none selects the enrollment owner instead

### Requirement: Initialize physical recovery from its actual production owner

Physical test initialization SHALL retain the production catalog's single enable
owner and actual automatic-connection generation. A driver SHALL NOT submit a
known-stale generation, enable an existing catalog again, ignore those refusals
or disable production reconciliation to make a recovery scenario pass.

#### Scenario: Production transport connects before the first workbench open

- **WHEN** the isolated production owner has already admitted a transport-only connection before the driver's sole initial business open
- **THEN** the driver SHALL observe that exact completed owner and use a legal newer generation for the explicit workbench request, verifying ready/entry identity
- **AND** later fault recovery SHALL remain exclusively production-driven within the unchanged original recovery budget, without additional explicit opens

#### Scenario: Initialization owner or generation is not admissible

- **WHEN** a setup reply is absent, malformed, stale, from a replaced or foreign scope, or cannot supply a legal newer generation
- **THEN** the driver SHALL refuse without an inferred generation, another explicit open, a catalog rewrite or an extended recovery deadline
- **AND** the fixture SHALL use its actual launch composition: every current Windows physical fixture runs production serve; it SHALL NOT fabricate an alternate owner, infer a mode from an error or start an extra timer to satisfy a false premise

### Requirement: Verify autonomous recovery under authorized program pauses

Program-pause verification SHALL be separate from uninterrupted application idle
and SHALL NOT be labeled UDP packet-loss proof. The user-approved replacement of
the unenforceable UDP profile SHALL use fresh test identities, pause only the
uniquely owned temporary core, and independently verify bounded cleanup before
pausing it. System firewall, networking and power policies SHALL remain unchanged.
Observers SHALL NOT manually reconnect a peer, reopen a page or restart DSH to
make recovery pass. Missing ownership, cleanup or timing proof SHALL fail closed.

#### Scenario: Short, long and repeated isolated core pauses

- **WHEN** an authorized test pauses its isolated core for about three
  seconds, thirty-five seconds, or repeated short pauses
- **THEN** releasing that pause starts the existing twenty-five-second recovery
  budget, including resume and acknowledgement
- **AND** both directions read back the original gateway, cookie, workspace,
  session and DSH runtime through production auto-connect policy
- **AND** a long outage's naturally closed WebSocket is not mislabeled as the
  original surviving carrier or native-tab recovery proof

#### Scenario: Controller dies while the core is paused

- **WHEN** the independently owned pause controller terminates unexpectedly
- **THEN** independently bounded native ownership resumes or terminates only its
  exact test core and records which outcome occurred in a fresh receipt
- **AND** failed cleanup remains explicit and blocks acceptance
- **AND** termination cleanup does not count as successful pause/resume recovery
- **AND** an expired cleanup window cannot admit another pause

#### Scenario: Native pause ownership or cleanup cannot be proved

- **WHEN** the native pause API, exact process ownership or independent cleanup
  cannot be verified
- **THEN** injection fails with a typed prerequisite error before pausing anything
- **AND** verification does not change system policy or call a no-op an outage

### Requirement: Verify isolated peer-process restart without new workbench intent

An explicitly authorized crash test SHALL terminate only its exact test-owned
peer process and restart it with the same explicit roots and identities. It SHALL
NOT mutate installed applications, system firewall policy or original services.
Process restart SHALL NOT be relabeled as UDP outage or overnight acceptance.

#### Scenario: Surviving client restores the restarted target

- **WHEN** a previously opened target core is killed and its candidate restarts
- **THEN** the surviving client's production automatic owner is observed without
  another connect request, page reopen, re-enrollment or DSH cold start
- **AND** original gateway, Cookie, workspace/session and running DSH readback are
  required within the unchanged recovery budget after target readiness
- **AND** the killed core's own lost gateway and cleared in-memory intent are
  reported separately, not claimed to survive its process lifetime

#### Scenario: Intentional teardown follows sealed business acceptance

- **WHEN** application acceptance has completed and test owners intentionally stop
- **THEN** the current healthy carrier is explicitly sealed, closed and joined
  before its manager/runtime is stopped
- **AND** earlier carrier failure cannot be overwritten as intentional cleanup

### Requirement: Retain causal diagnostics without credentials

Each transport/session SHALL retain and log its first termination cause and
trigger with current scoped identities, state and available receive/lease timing.
Cleanup SHALL NOT replace that first cause with a secondary close or cancellation.
Unknown statistics SHALL remain explicitly unknown; diagnostics SHALL NOT expose
payloads, tokens, cookies, gateway URLs, ICE credentials or private keys.

#### Scenario: Connection ends after reaching ready

- **WHEN** an ICE, channel, lease, mux, endpoint or owner event ends a ready attempt
- **THEN** the first trigger and actual boundary are recorded for that attempt
- **AND** later shutdown events cannot overwrite it or publish false readiness

### Requirement: Recovered transport invalidates old grace callbacks

The existing twenty-second grace SHALL belong to its specific disconnect window.
An expired callback that lost ownership SHALL NOT terminate a recovered transport
or a later disconnect window, even when timer execution has already begun.

#### Scenario: Connected races an already started expiry callback

- **WHEN** recovery invalidates the old grace window before its callback commits
- **THEN** that callback does not close the recovered transport
- **AND** a still-owned unrecovered window retains the existing failure deadline

### Requirement: Verify long idle without reopening pages

Long-duration physical verification SHALL preserve both original authenticated
application sessions and WebSockets for the requested eight hours without
business traffic, manual redial, page reopening or runtime restart. Any earlier
loss SHALL retain its actual failure evidence rather than reset the interval.

#### Scenario: Bidirectional eight-hour application idle

- **WHEN** both real workbenches are open on the authorized physical hosts
- **THEN** eight hours later both original connections read back their original
  cookie, workspace/session and gateway identity through the original WebSockets
- **AND** packet/owner failures observed earlier remain explicit failures

### Requirement: Close and reopen remote browser tabs

The shell SHALL retain a permanent Local tab and allow opened SSH/P2P browser
tabs to close through a visible labelled action and keyboard Delete. Closing a
tab SHALL remove its guest and page-navigation state without disconnecting the
transport, stopping remote DSH, removing a record or changing authorization.
This supersedes the earlier permanent remote-tab behavior.

#### Scenario: Close an active or background remote tab

- **WHEN** a user closes an opened remote tab
- **THEN** its guest is unmounted and the device becomes available in the add menu
- **AND** closing the active tab selects the right neighbor, or left neighbor at
  the end, while closing a background tab preserves selection
- **AND** keyboard focus moves to the selected surviving tab; Local cannot close

#### Scenario: Reopen or reconnect a closed computer

- **WHEN** a user selects a closed SSH/P2P computer in the add menu
- **THEN** the shell creates exactly one new guest through the existing admission
- **AND** a ready connection is reused, while a disconnected/failed SSH record
  connects through the existing operation and pending operations reject repeats
- **AND** a late connect or entry response cannot reopen a tab the user closed

### Requirement: Restore explicitly requested workbenches

The core SHALL retain an admitted explicit workbench request for its service and
pair during the running core's lifetime. After transient transport loss it SHALL
automatically request that workbench again and restore its original local gateway
without another explicit connect, login, or DSH restart. A connection SHALL be
workbench-ready only after the current runtime binding and HTTP/WebSocket path
have passed the existing readiness checks.

#### Scenario: Overnight transport recovery

- **WHEN** an explicitly opened workbench loses its transport and the authorized
  peer becomes reachable again
- **THEN** automatic recovery restores the workbench at the same local port,
  with the original browser partition and valid HTTP and WebSocket access
- **AND** no second manual connect or replacement device identity is required

#### Scenario: Runtime temporarily unavailable

- **WHEN** transport recovers but a requested workbench is temporarily unavailable
- **THEN** the system retains the workbench intent and actual transport-only state
  and retries through the existing bounded-backoff policy
- **AND** it does not report workbench readiness or serve stale content

#### Scenario: A candidate explicitly negotiates an unavailable workbench

- **WHEN** a verified candidate receives an explicit workbench refusal and no runtime binding
- **THEN** its exact transport and mux MAY become a connected primary only after the unchanged authoritative candidate decision barriers, retaining the typed refusal and workbench intent without a browser entry
- **AND** the refusal SHALL be retained before Ready dispatch and across connected/suspended/connected transitions; suspension itself SHALL keep its existing empty-error projection
- **AND** promotion SHALL detach the predecessor's exact runtime mux before publishing connected while retaining the stable listener for later verified recovery
- **AND** unexplained empty bindings and failed probes of a provided binding SHALL NOT be accepted as this explicit transport-only outcome

### Requirement: Background connections do not activate workbenches

A pair that has never received an explicit workbench request SHALL remain a
transport-only connection during background recovery. Receiving another computer's
connection SHALL NOT create a reciprocal workbench-opening intent.

#### Scenario: Background fleet recovery

- **WHEN** multiple authorized devices reconnect and only one was explicitly opened
- **THEN** only that device's workbench is requested and the other devices' DSH
  processes are not activated

### Requirement: Automatic recovery respects a stopped runtime

Automatic recovery SHALL only reattach a DSH runtime that is already running on
the target. It SHALL NOT cold-start a stopped or failed runtime, including one the
target user explicitly stopped. A fresh manual open SHALL retain the existing
explicit-start behavior. The recovery request SHALL be distinguishable from an
explicit start across both the peer protocol and the runtime-owner boundary.

#### Scenario: Target user stopped DSH

- **WHEN** a previously opened workbench reconnects after the target user stops DSH
- **THEN** the network transport may recover but the workbench remains unavailable
  and no automatic runtime request starts DSH
- **AND** a later explicit open can request DSH through the normal launch admission

#### Scenario: Peer lacks safe resume capability

- **WHEN** the target cannot prove support for reattaching without starting DSH
- **THEN** automatic workbench recovery is explicitly refused without treating it
  as ready and without substituting an explicit-start request

### Requirement: Scope recovery to current authorization and attempt ownership

Workbench intent and gateways SHALL be scoped to the exact service and pair.
Explicit disconnect, service removal, pair or network revocation, and core shutdown
SHALL clear the corresponding intent. Late attempts and cleanup SHALL NOT replace
or detach a newer attachment. Opposite-direction sessions SHALL remain independent.

#### Scenario: Disconnect or authorization removal

- **WHEN** a workbench is explicitly disconnected or its authorization is removed
- **THEN** the old gateway cannot serve content and subsequent background recovery
  does not request that workbench unless explicitly opened again

#### Scenario: Superseded and bidirectional attempts

- **WHEN** an older attempt completes or cleans up after a replacement is current,
  including a concurrently established opposite-direction session
- **THEN** it cannot detach, replace, or publish the current attempt's gateway

### Requirement: Read back authoritative browser entries

The desktop shell SHALL resolve recovered entries from the current core owner for
the exact service, pair, and generation before mounting the existing browser tab.
It SHALL reject non-ready, stale, revoked, missing, or malformed replies explicitly.
The existing renderer-facing entry operation and stable pair-specific partition
SHALL remain unchanged; credentials SHALL NOT enter general connection state.

#### Scenario: Automatic ready announcement

- **WHEN** the core announces a recovered ready generation without a manual connect
- **THEN** the shell obtains that generation's verified loopback entry and remounts
  the previously opened tab in its original isolated partition
- **AND** it does not infer the new entry from a cached previous generation

#### Scenario: Entry lookup superseded or revoked

- **WHEN** the attempt or authorization changes during an entry lookup
- **THEN** the old reply is refused and cannot mount content for another attempt

### Requirement: Preserve original state and explicit failures

Recovery SHALL preserve existing devices, networks, pairs, and browser isolation.
It SHALL NOT guess missing roots, activate a different DSH version, substitute
another server, or delete credentials to hide an error. Application restart clears
in-memory workbench intent; opening an explicit workbench creates a new intent.

#### Scenario: Reset and missing prerequisites

- **WHEN** the core restarts or the requested runtime lacks required launch inputs
- **THEN** background transport does not invent workbench intent, and any explicit
  runtime request retains the owning subsystem's typed refusal

### Requirement: Ordinary maintenance preserves terminal intent scope

Catalog updates and ordinary system resume SHALL NOT clear terminal refusals or
grant fresh authorization. Catalog updates SHALL reconcile existing intent, and
resume MAY cancel transient backoff while preserving terminal intent. Only the
existing exact service/pair's freshly authorized durable publication may reset
its terminal state through the epoch-fenced engine owner, using explicit
Reauthorize or D36's atomic RecoverAuthorization admission.

#### Scenario: Another service changes or the system resumes

- **WHEN** service B has a terminally refused intent and service A announces a catalog revision, or the desktop resumes normally
- **THEN** B SHALL retain its terminal refusal and SHALL NOT redial without its own fresh exact authorization
- **AND** the old global clear-refusals shell method SHALL be absent and an attempted invocation SHALL fail with the existing unknown-method refusal

#### Scenario: Exact durable authorization supersedes an in-flight result

- **WHEN** the exact service/pair is successfully reauthorized while an old connect result remains in flight
- **THEN** only that intent's epoch SHALL advance and its old result SHALL NOT republish a terminal refusal or backoff
- **AND** other intents SHALL retain their original terminal state and one connect owner remains joined

### Requirement: Choose network authority without duplicating a computer

One remote computer SHALL retain one connection record and browser tab even when
it has active pairs in multiple networks. The existing exact network SHALL be
retained only with fresh current-account authorization. A new ambiguous remote
SHALL require an explicit user network choice and SHALL NOT block other devices.
Named typed choice/read operations SHALL check current user, catalog revision,
registration and fresh selected membership; renderer input SHALL NOT supply pins.

#### Scenario: Existing network remains authorized

- **WHEN** a device appears in multiple networks and its saved network is still
  freshly authorized
- **THEN** bootstrap retains that exact network regardless of discovery ordering
- **AND** it does not pin the other network or duplicate the device/tab

#### Scenario: First connection has multiple networks

- **WHEN** a remote has multiple active authorized networks and no saved choice
- **THEN** no network is selected implicitly and no live pin is granted for it
- **AND** the add-tab floating dialog offers a labeled explicit network choice
- **AND** other unambiguous devices remain usable

#### Scenario: Choice is revoked, superseded or loses its reply

- **WHEN** the user/account, catalog revision or network authority changes during
  selection, or the committed result is unknown
- **THEN** the old request cannot authorize a different scope or open a late tab
- **AND** genuinely revoked original authority is not replaced automatically;
  choosing a different scope uses the owning revoke/retire transition before
  recording new authority
- **AND** unknown outcomes are read back, never retried under another network

#### Scenario: Explicit reselection cannot persist an intermediate missing identity

- **WHEN** explicit reselection validates its revoke, retire and fresh identity
  transitions and a validation, CAS or pre-publication write fails
- **THEN** the owning catalog atomically publishes no intermediate record; original
  bytes and revision remain intact and its strict identity guards are unchanged
- **AND** repeated complete empty discovery retains stale selection lineage, so
  a later sole alternative still requires the user's explicit choice

### Requirement: Fresh original authorization repairs local revoked state

Automatic catalog synchronization SHALL restore a saved connection whose local
state is revoked when fresh current-account network, pair and scoped identity
reads confirm active authority for the same service, user, original network,
local and remote device IDs, and both original public keys. The local revoked
flag SHALL NOT require manual network reselection in that case. Recovery SHALL
use the owning atomic catalog transition and current selected-session and
registration fences; cached state or discovery order SHALL NOT grant authority.

#### Scenario: Original network and pair remain active

- **WHEN** a saved local revoked connection has freshly confirmed active server
  authority for its exact original scope and device keys
- **THEN** automatic synchronization atomically retires the revoked row and
  records active authority without a user selection or intermediate deletion
- **AND** only that durably recovered service/pair is reauthorized through its
  existing automatic connection owner, without opening a tab or starting DSH

#### Scenario: Repeated synchronization and restart

- **WHEN** the same original authority is synchronized again or read after restart
- **THEN** the connection remains one active record with its original network,
  device identities and keys, without creating a duplicate or requiring selection
- **AND** an already active unchanged record without a recoverable authorization
  refusal does not reset engine terminal state or in-flight epochs

#### Scenario: Network choices read encounters recoverable stale authority

- **WHEN** `pairs.network_choices` freshly confirms exact original authority,
  including a revoked record, a recoverable authorization refusal, or a durable
  active record whose live pin was lost with an earlier publication reply
- **THEN** it commits the exact catalog/live pin before returning `selected` and
  the resulting catalog revision, or returns the owning explicit refusal
- **AND** an unchanged record uses a no-op CAS without a file write or revision
  change, while ordinary active reads do not reset engine terminal state
- **AND** recoverable refusals are limited to `p2p.pair_unauthorized`,
  `p2p.pair_revoked`, `p2p.pair_not_found` and `p2p.network_revoked`
- **AND** recovery cannot clear identity, trust, lease, device-authorization,
  unrelated or runtime/transport terminal failures

#### Scenario: A different terminal failure wins during recovery

- **WHEN** the exact engine intent acquires a non-authorization terminal refusal
  after an earlier recovery check but before its stop can be reset
- **THEN** the recovery owner atomically rechecks that current stop and preserves
  its error, epoch and connection owner instead of clearing the newer failure

#### Scenario: Original authority is absent or identity changes

- **WHEN** the original network or pair is revoked or absent, the selected account
  changes, or either original device ID or public key differs from fresh authority
- **THEN** automatic synchronization grants no replacement authority
- **AND** another authorized network, even a sole alternative, is not selected
  without the user's explicit choice

#### Scenario: Fresh read or publication cannot complete

- **WHEN** an authoritative read, catalog validation, CAS or pre-publication write
  fails, or the selected session or registration changes before publication
- **THEN** recovery grants no live pin and cannot publish a late active record
- **AND** original durable bytes and revision remain intact before publication;
  an unknown publication outcome is resolved by authoritative readback
- **AND** recovery does not clear another service/pair's terminal refusal

### Requirement: Running DSH survives a network-core crash

A separately authenticated runtime owner SHALL retain the actual child process,
output pipes, reaper, console cursor and binding generation when its network core
crashes. Both production core entry points SHALL reconnect to that same authority
using exact registered configuration and executable identity. Reconnection SHALL
NOT invoke start, guess a PID, reuse a cached URL or replace an unavailable owner.
The owner SHALL NOT open account credentials or access the coordination server.

#### Scenario: Core restarts while DSH is running

- **WHEN** an isolated core is killed and restarted with identical explicit roots
- **THEN** its existing authenticated runtime owner returns the original live
  child, launch identity and binding generation without another child start
- **AND** the surviving remote client's original intent can resume that runtime
  through production recovery, within the unchanged acceptance budget

#### Scenario: Owner unavailable or record invalid

- **WHEN** the private owner is unreachable, incompatible, corrupt or belongs to
  different registered roots or executable identity
- **THEN** the core returns a typed refusal without adopting another process,
  creating another owner, starting DSH or exposing a cached runtime binding
- **AND** local launch/stop and remote connection results retain that ownership
  error with localized copy instead of claiming a missing Harness checkout

#### Scenario: Explicit stop and normal shutdown

- **WHEN** the user stops DSH or normally shuts down the owning core
- **THEN** the runtime authority invalidates the binding and joins its owned child
  tree; automatic resume cannot revive it
- **AND** merely losing the core RPC connection does not stop the runtime owner

### Requirement: Answer-side retirement cannot swallow a successor handshake

An answer-side candidate SHALL retain exact cleanup ownership without holding a
terminal reservation against the next scoped handshake. A current Prepared that
finds an unresolved older reservation SHALL have at most one immutable, joinable
admission owner with a bounded signal inbox; it SHALL NOT obtain transport or
runtime authority until exact durable State proves a legal ownership transition.
Unknown state, a newer generation or a historical signed ticket alone SHALL NOT
authorize retirement. Reception SHALL remain nonblocking and SHALL log bounded,
credential-free typed admission decisions with exact scope and owner identity.

#### Scenario: Terminal cleanup or End is still blocked

- **WHEN** an exact validated terminal receipt retires the old pending candidate
  and a new Prepared and offer arrive before its transport/End cleanup finishes
- **THEN** the original successor handshake is retained without retransmission
- **AND** old cleanup remains joinable and cannot delete the successor reservation

#### Scenario: Historical Prepared precedes its terminal readback

- **WHEN** re-registration installs an old Prepared and a new Prepared/offer arrives
  before a fresh exact-ticket State read confirms the old terminal decision
- **THEN** one fenced admission owner preserves the new handshake until that proof
- **AND** pending, unknown, malformed, foreign or unauthorized State cannot evict
  the old owner, construct a transport or claim readiness

#### Scenario: Authority changes while admission is pending

- **WHEN** account, network, pin, subscription, core lifetime or reservation identity
  changes while the exact old-ticket read is pending
- **THEN** the late result cannot publish a successor into the replacement scope
- **AND** shutdown joins the owned worker without waiting inside the receive loop

### Requirement: Grace recovery cannot prematurely retire the original workbench

Each endpoint SHALL retain an exact suspended predecessor's original recovery
authority while its existing usable workbench remains in recovery before
publishing candidate Ready. The candidate SHALL wait for actual predecessor
termination or cancel itself if the original transport recovers. Scope mismatch
and expiry SHALL fail explicitly. Waiting SHALL NOT extend the original grace,
ticket, lease or business deadline, consume another owner's event channel, or
roll back a dispatched or verified committed coordinator decision.

#### Scenario: A replacement becomes ready during the original grace

- **WHEN** either endpoint has staged a replacement but its exact original
  workbench transport has not terminated and remains in recovery
- **THEN** that endpoint publishes no candidate Ready or Commit and preserves
  its original mux and browser connections
- **AND** recovery cancels the uncommitted replacement even if disconnected and
  connected notifications were coalesced before the public projection changed

#### Scenario: Original authority ends before recovery

- **WHEN** the exact predecessor terminates under its unchanged grace or lease
  and the candidate's original authorization and scope remain valid
- **THEN** candidate readiness may proceed through the existing both-ready CAS
- **AND** explicit remote-core replacement and transport-only workbench upgrade
  keep their distinct existing behavior rather than waiting for an unrelated
  healthy transport to terminate

### Requirement: Windows local runtime commands stay in the background

Windows local runtime commands SHALL suppress console-window creation for launch,
port inspection and process-tree termination while preserving their existing
stdout/stderr pipes, output, errors, readiness and process ownership. The shared
platform command constructor SHALL apply `HideWindow` and `CREATE_NO_WINDOW`
on Windows. Non-Windows helper commands and supervised process-group behavior
SHALL retain their existing contracts. This change SHALL NOT alter SSH flows,
runtime-owner lifetime, launch/Stop meaning, logging or renderer capabilities.

#### Scenario: Start local DSH on Windows

- **WHEN** the runtime owner starts the local supervised DSH console program
- **THEN** its process has no new console window and its standard output/error
  still reach the existing Launcher Console/log and URL readiness owners
- **AND** exit receipts and independent runtime-owner survival remain unchanged

#### Scenario: Inspect the local port or stop its process tree

- **WHEN** the Windows runtime invokes its existing port-inspection tools or
  `taskkill` for the owned process tree
- **THEN** the helper runs without a new console window and returns its actual
  output and exit/error result to the existing caller
- **AND** the existing termination arguments and cleanup ownership are preserved

#### Scenario: Execute on a non-Windows platform

- **WHEN** the runtime starts a helper command or its supervised DSH process on
  a non-Windows platform
- **THEN** helper construction adds no Windows attributes and the supervised
  child retains its existing process-group and stop-signal behavior

### Requirement: Explicit workbench requests share the unique connection owner

An explicit Run-page connection SHALL dispatch once without first starting
background retries. When a bind-only or resume candidate owns the outbound slot,
one exact waiting explicit request MAY retain its own generation and intent until
that candidate safely promotes or finishes cleanup. The request SHALL revalidate
account, pin/device/key, subscription, registration and cancellation ownership
atomically with its new reservation. It SHALL NOT upgrade the borrowed
candidate's negotiation or return its old generation as the new request's result.

#### Scenario: A user connects while background preparation is in flight

- **WHEN** the exact authorized pair has a background candidate and the user
  requests its workbench
- **THEN** the existing candidate remains the unique owner until its actual
  outcome, and at most one explicit waiter is registered
- **AND** after safe promotion or cleanup, the waiting request reserves its own
  current generation and explicit workbench permission
- **AND** a healthy promoted primary does not have to terminate for the request

#### Scenario: A pending explicit request is cancelled or loses authority

- **WHEN** its caller leaves, Disconnect occurs, or its account, pin/key,
  subscription, registration or manager lifetime changes while waiting
- **THEN** the request cannot reserve a late replacement or revive old intent
- **AND** caller cancellation does not cancel the borrowed background owner
- **AND** a stale explicit generation remains a typed refusal

### Requirement: In-flight preparation and refusal readback remain truthful

A pre-ticket reservation SHALL expose its actual preparation attempt and
generation as in-flight without claiming server admission or Ready. It SHALL NOT
replace an existing primary's public projection. Renderer busy hints SHALL be
scoped by service and pair and yield to that pair's subsequent actual state.
An accepted reply and a delayed main callback SHALL NOT leave the Run page
permanently showing an empty snapshot and a historical busy hint.

#### Scenario: Preparation has not yet returned a ticket

- **WHEN** a current candidate owns an initial pair's outbound slot
- **THEN** its actual attempt and generation are observable as in-flight
- **AND** neither a workbench URL nor Ready is fabricated
- **AND** a different computer's busy record is not displayed for this pair

#### Scenario: Rate limiting follows an ambiguous prepare reply

- **WHEN** an attempt previously had a lost, malformed or transport-ambiguous
  prepare result and a later replay is rate-limited with a temporary missing read
- **THEN** the same attempt remains owned for authoritative resolution
- **AND** only an attempt with no ambiguous dispatch history may return a fresh
  explicit rate-limit plus same-scope absence to the existing retry backoff

#### Scenario: A late connection callback follows an accepted reply

- **WHEN** the current connection reply precedes its renderer-visible callback
- **THEN** readback continues under the exact accepted identity until actual state
  is known or authority ends, without dispatching another connection
- **AND** historical busy is cleared only for the matching pair and actual state
