# P2P shell (launcher main-process) pairing / identity / catalog audit

Scope: `electron/main/p2p/**`, the catalog core boundary (`electron/main/core/catalog.ts`),
the Go catalog/pin side it talks to (`networking/internal/catalog/**`,
`networking/internal/peersession/**`), and the renderer surfaces that show pairing
state (`src/app/domains/remote-connections/**`, `src/app/shell/runtimeBrowserState.ts`,
`P2PRunActions.vue`, `P2PPairingPanel.vue`, `RuntimeTabAddMenu.vue`,
`src/shared/p2p-management.ts`, `src/shared/p2p-refusal.ts`, `src/app/shared/i18n/messages.*`).

Investigation only; no file was modified except this report.
Baseline: `0140a70` (the `p2p.revocation_required` convergence fix `d462b30` is already in).

Legend: **[wedge]** = state only a restart or a manual re-pair escapes.

---

## 1. `member-catalog.ts` re-records a locally-revoked computer only as revoked — a re-paired peer never comes back

- **Severity: high.** A computer the user re-paired (or that re-joined) stays "Revoked"
  and can never be connected again on this machine.
- **Evidence:** `electron/main/p2p/member-catalog.ts:57,69,93`
  ```ts
  const recorded = new Set(computers.map((computer) => computer.connectionId))
  ...
  if (recorded.has(remote.deviceId)) continue          // 69
  ...
  if (computer.pairState === 'revoked' || recorded.has(computer.connectionId)) continue  // 93
  computers.push({ ...computer, pairState: 'revoked' })                                   // 94
  ```
- **Symptom:** the peer re-pairs (new `pairId`, new `networkId`, higher revision). The
  sync's first loop at `member-catalog.ts:53-56` keeps only rows of *other* services, so
  `computers` starts empty and `recorded` is also empty; the active member is matched at
  line 69 against `recorded` (empty) and is therefore **skipped** — its row already exists
  in `saved.record.computers` as `revoked`, but line 69's `add` never happens for it. The
  second loop then hits line 93 and skips it too (already revoked, and `recorded` no longer
  contains its id either), so the row stays `revoked` forever. The Run tab keeps it as
  "Revoked"/disconnected and `P2PRunActions.vue:26,38` refuses to connect a revoked row.
- **Minimal fix:** in `recordMembers`, key the "already recorded" set on
  `remote.deviceId` **and** treat a revoked row as replaceable:
  - build `reresolved = new Set(computers.map(c => c.remoteDeviceId))` from all rows this
    service owns (not only non-remote rows), and
  - before the second loop, drop rows whose `remoteDeviceId` is in the newly recorded
    remote set when they are `revoked` (legal transition: dropping a revoked row is
    allowed by `catalog-transition.ts:47` and `networking/internal/catalog/transition.go:66`).
- **Test:** extend `member-catalog.test.ts` — fixture holds one `pairState:'revoked'` row for
  remote `6…`, then call `recordMembers(..., [member({target:{deviceId:'6…'}})])` and assert
  the committed row for `6…` is `active` with the new `pairRevision` (today it stays revoked).

---

## 2. Two networks between the same two devices produce the *same* connection id → `p2p.catalog_invalid` and a silently dead peer

- **Severity: high.** One of two peers in a shared second network never appears, and the
  member sync fails for that service forever with no user-visible reason.
- **Evidence:** `electron/main/p2p/member-catalog.ts:69-79`
  ```ts
  if (recorded.has(remote.deviceId)) continue   // dedupe by REMOTE DEVICE ID
  ...
  connectionId: remote.deviceId,
  pairId: remote.deviceId,                      // <-- pairId := remote device id
  ```
  The schema then refuses two rows with the same `serviceId:pairId`
  (`catalog-schema.ts:80`, mirrored by `networking/internal/catalog/record.go:135-144`), so
  `PeerCatalog.commit` rejects synchronously with `p2p.catalog_invalid` at
  `catalog.ts:75` (`parsePeerCatalog(encoded)`), before the core is even asked.
  `management.ts:630-650` only retries `p2p.service_busy`, so this failure is logged as
  `[p2p] network member sync failed:` and never reaches the UI, and repeats on every sweep
  (`management.ts:253-255`).
- **Symptom:** with the same peer on two networks, the row stored is whichever member comes
  first in the coordinator's list; the other network's pair can never be connected (the
  coordinator keys an attempt by pair, and the losing `pairId` is not in the catalog), and
  every later sync for the service fails outright, so *no* later membership change lands.
- **Minimal fix:** make the dedupe *and* the identity explicit. Add a
  `connectionIdFor(serviceId, remoteDeviceId, pairId)` helper (e.g.
  `sha256(serviceId + ':' + member.pairId)` hex-truncated to 32) in `member-catalog.ts`,
  use it as `connectionId`, and mark the extra pair by keeping `pairId` distinct — this needs
  a catalog field that carries the real coordinator `pairId` (see finding 3's
  `coordinatorPairId`) because the attempt key is the **pair id**, not the device id
  (`pairing.ts:311-331`, `pairing.ts:321-324`). If the product only supports one pair per
  device, reject the second explicitly with a new typed refusal
  `p2p.multiple_networks_unsupported` instead of committing an invalid record.
- **Test:** `member-catalog.test.ts`: two members with the same remote device id and
  different `networkId`/`pairId`; assert the committed record parses (no duplicate
  `serviceId:pairId`) and that both pairs are represented or the typed refusal is thrown.

---

## 3. A peer removed while this app was closed is invisible: the catalog row stays **active** and auto-connect loops forever

- **Severity: high.** "Computer listed but can never connect", with no error text anywhere.
- **Evidence:** `electron/main/p2p/member-catalog.ts:60`
  ```ts
  if (member.state !== 'active' || member.revision <= 0) continue
  ```
  A pair the coordinator reports as `revoked` is simply not recorded, so the *existing*
  local row keeps `pairState: 'active'` and is never marked revoked. On the Go side a
  revoked pair is not pinned (`manager.go:119` requires `pin.Pair.State == "active"`) and —
  critically — a "revoked" signal event only exists while the app is running
  (`networking/internal/peersession/manager.go:475`, `networking/internal/controlplane/signals.go:120`).
  So after an offline removal: catalog row active → `autoConnect.reconcile()` keeps the
  intent (`management.ts:96-100`) → `connect` → helper `pins` map has no entry →
  `p2p.pair_unauthorized` (`manager.go:154-158`), which is **not** in
  `auto-connect.ts:31-40` `TERMINAL_CODES`, so the retry loop runs forever.
- **Symptom:** the computer looks paired and active, the user clicks connect, and gets
  "Connection failed" (`P2PRunActions.vue:31,57` shows only the label; `live.error` is never
  rendered in that component) — forever.
- **Minimal fix:** make the member list authoritative in both directions.
  1. `pair-records.ts` `PeerPairMember` gains `state` (already present) and the projection
     must reach `recordMembers`; in `member-catalog.ts` match rows by
     `remoteDeviceId` (not only by being newly recorded) and, when a member for that remote
     exists with a terminal state (`revoked`/`rejected`), write
     `{...row, pairState:'revoked', pairRevision: member.revision}` (raising the revision is
     required: `catalog-transition.ts:57-61` refuses a lower revision).
  2. Add `p2p.pair_unauthorized` (and `p2p.network_revoked`, `p2p.pair_not_found`) to
     `TERMINAL_CODES` in `auto-connect.ts:31` so the loop stops, and project
     `autoConnect.refusal()` through the `serviceSessions`/`connections` read so the row can
     say *why*.
- **Test:** `member-catalog.test.ts` — a row `active` + a member list containing that remote
  with `state:'revoked'`; assert the committed row is `revoked` and its `pairRevision` is the
  member's. `auto-connect.test.ts` — `connect` rejecting `p2p.pair_unauthorized` schedules no
  further timer and `refusal()` returns the code.

---

## 4. Every member-sync failure except `p2p.service_busy` is dropped into the console forever

- **Severity: high** (it silently converts a transient failure into a permanently stale
  catalog).
- **Evidence:** `electron/main/p2p/management.ts:645-652`
  ```ts
  // This sync prunes pairs the coordinator no longer has: a lock collision
  // must not drop it.
  if (!(error instanceof PeerHelperError) || error.code !== 'p2p.service_busy') {
    console.error('[p2p] network member sync failed:', error)
    return
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  await sync().catch((retried) => console.error('[p2p] network member sync failed:', retried))
  ```
  Only `p2p.service_busy` gets a (single, 250 ms) retry. Every other failure — including the
  `p2p.catalog_invalid` of finding 2, the `p2p.identity_mismatch` of finding 5 and the
  `p2p.catalog_conflict` of finding 17 — takes the `return`, so it is never retried by this
  call and never reaches any surface. The next attempt is the 60 s sweep
  (`management.ts:253-255`), which runs the identical deterministic path, so a persistent
  cause never converges and the user-visible list simply stops updating.
- **Symptom:** membership changes silently stop landing on this machine while the app keeps
  claiming the old list; the only trace is a main-process console line.
- **Minimal fix:** separate "retry once" from "surface": keep the 250 ms retry for
  `p2p.service_busy`, and for every other code record a per-service member-sync failure in
  the existing `#sessions` map (e.g. `code: 'p2p.member_sync_failed'` plus the underlying
  code in a new field) so `serviceSessions` (`management.ts:309-323`) can report it, and add
  a locale key (`p2p.myNetwork.memberSyncFailed`) to `messages.en-US.ts` /
  `messages.zh-CN.ts` for the Connect card.
- **Test:** `management.test.ts` — make `pairs.identity` reject `p2p.identity_mismatch` and
  assert `serviceSessions()` reports the failure code for that service and that the Connect
  card's copy exists in both dictionaries.

---

## 5. `PeerPairing.members()` fails the whole sync on the first pair it cannot use

- **Severity: high [wedge].** One stale pair identity hides **every** computer of that
  service, on both machines, with no recovery except re-pairing by hand.
- **Evidence:** `electron/main/p2p/pairing.ts:75-90` — `members()` is an all-or-nothing
  pipeline:
  ```ts
  const pairs = peerPairs(await this.#call(serviceId, 'pairs.list', {}, signal), local)
  for (const pair of pairs) {
    members.push(peerPairMember(await this.#call(serviceId, 'pairs.identity', { pairId: pair.pairId }, signal), local))
  }
  ```
  `peerPairs` (`pair-records.ts:220-221`) and `peerPairMember` (`pair-records.ts:209-210`)
  both throw `p2p.identity_mismatch` when the local device id is neither side of the pair —
  which is exactly the state left behind by a re-enrollment under a new device identity, the
  scenario the 0.1.38 fix was about. One such dangling pair makes `members()` reject, so
  `#recordMembers` never runs (`management.ts:685`) and the catalog never converges.
  This is a second permanent-wedge mechanism *beside* the fixed one: the fixed one fired on a
  valid member list, this one fires before the list is even built.
- **Symptom:** "Windows could see the Mac, the Mac saw only itself" persists even after the
  0.1.38 fix, because the Mac's sync dies at `pairs.identity`.
- **Minimal fix:** `PeerPairing.members` must be tolerant per pair: wrap the `pairs.identity`
  call in a `try/catch` for `p2p.identity_mismatch` / `p2p.pair_not_found` only, skip that
  pair, and return the members it could read. Let `recordMembers` (finding 3) decide the
  local row's fate from absence. Add a new typed refusal surface code
  `p2p.member_identity_unusable` recorded per service so it is visible rather than silent.
- **Test:** `pairing.test.ts` — `pairs.list` returns two pairs, the first `pairs.identity`
  answers with a pair naming a different device; assert `members()` resolves with the second
  member only, and that the skipped pair id is reported (not thrown).

---

## 6. Peer device removed and re-joined: a stale row is never pruned, and the row is keyed to an identity that no longer exists

- **Severity: high.** Duplicate dead "Revoked" computers accumulate; the live one is not the
  old one, and nothing removes the old one.
- **Evidence:** `electron/main/p2p/member-catalog.ts:53-56,90-94`
  ```ts
  const computers = saved.record.computers.filter(
    (computer) => computer.serviceId !== serviceId && computer.remoteDeviceId !== credential.deviceId
  )
  ```
  Only rows naming **this machine** as the peer are dropped. A row whose `localDeviceId` is an
  old identity of this machine (`A1`) and whose `remoteDeviceId` is the peer's old identity
  (`B1`) is kept. When the peer re-enrolls as `B2` and the pair is re-adopted, the new member
  creates a row keyed by `B2`; the `A1/B1` row is never reported by the coordinator again, so
  loop 2 of `recordMembers` sets it `revoked` (line 94) — and since it is then skipped by
  line 93 forever, it is never dropped either. `runtimeBrowserState.ts:133-147` renders one
  tab per row, so the user gains a permanent dead tab per re-enrollment.
- **Symptom:** computer appears twice; the old one is "Revoked" forever; the newly paired one
  may appear only after finding 3 is fixed.
- **Minimal fix:** prune rows of *this* service whose `localDeviceId !== credential.deviceId`,
  regardless of `pairState` — they are already revoked (if they are not, mark them revoked in
  the same commit first). Concretely, in `recordMembers` extend the filter at line 53-56 with
  a third clause `|| (computer.serviceId === serviceId && computer.localDeviceId !== credential.deviceId)`,
  and in the second loop drop rows with `localDeviceId !== credential.deviceId` (legal because
  the guard only protects *active* rows). Add `p2p.catalog.identityPruned` to the diagnostics
  log so the loss stays visible.
- **Test:** `member-catalog.test.ts` — fixture row with `localDeviceId: '9'…` ≠ credential,
  `pairState: 'revoked'`; assert it is absent from the committed record, and with
  `pairState: 'active'` assert it is first marked revoked and dropped on the next rewrite.

---

## 7. Switching accounts: the previous account's device stays restored and its computers stay visible and connectable

- **Severity: high.** Account B inherits account A's device identity, catalog rows and pins.
- **Evidence:**
  - `electron/main/p2p/management.ts:542` — `if (this.#restored.has(serviceId)) return session`
    returns before `device.restore` and before any credential check, so the helper keeps
    device A for the whole helper lifetime (`#restored` is only cleared on
    `removeService`, `management.ts:400`, or helper loss, `management.ts:970`).
  - `management.ts:543-568` — `#readyAsDevice` reads device A's credential and passes it to
    `device.restore`; the reply is only *shape*-checked:
    ```ts
    exactPeerObject(await session.rpc.call('device.restore', {serviceId, data:{device:…, pins: []}}, …), ['deviceId'])
    ```
    `deviceId` is never compared with the credential (contrast `enrollment.ts:164-165`, which
    does compare). The Go handler refuses a second restore with `p2p.invalid_device_state`
    (`networking/internal/helper/host.go:188-190`) and `management.ts:569-573` treats exactly
    that code as "already restored: not an error" — so a *different* device in the helper is
    indistinguishable from a successful restore.
  - `electron/main/p2p/enrollment-bootstrap.ts:45-46` —
    ```ts
    const stored = await host.credentials.loadRegistration(serviceId).catch(() => undefined)
    if (stored?.kind === 'registered') return true
    ```
    no `userId` comparison, so signing in as B never re-enrolls. `PeerCredentialStore` is
    keyed by `serviceId` only (`credentials.ts:338-339`), and `logout` clears nothing
    (finding 14).
  - `member-catalog.ts:58-88` filters only by `deviceId`/`publicKey`, never by `userId`, so
    pairs the coordinator returns for device A (the device id it was asked about) are
    recorded and `#syncMembers` (`management.ts:672-684`) pins them under B's session.
- **Symptom:** after switching accounts, A's computers remain listed and "active"; connect
  attempts fail with `p2p.pair_unauthorized`/`p2p.identity_mismatch` at the pin
  (`networking/internal/peersession/manager.go:119` requires `local.UserID == manager.config.Device.UserID`),
  or the device banner shows the wrong `deviceId`; the UI offers no re-enroll action.
  **[wedge]** until a manual re-pair or a credential wipe — `enrollment-bootstrap` will never
  fix it because the credential record exists.
- **Minimal fix:** make the account the owner of the device identity.
  1. `enrollment-bootstrap.ts`: change `EnrollmentHost.signIn` to return the signed-in
     `userId` (or add `currentUserId(serviceId)`), and when
     `stored.kind === 'registered' && stored.credential.userId !== userId`, throw the new
     typed refusal `p2p.device_owner_mismatch` instead of returning true.
  2. `management.ts:542-575`: include `saved.credential.deviceId` (and `userId`) in the
     `#restored` key — e.g. `#restored` becomes `Map<serviceId, credentialDigest>` — and
     compare the `device.restore` reply's `deviceId` with the credential, throwing
     `p2p.identity_mismatch` on mismatch (so "already restored" cannot masquerade as success).
  3. `member-catalog.ts`: skip any member whose local side `userId` differs from
     `credential.userId`, so another account's pairs are never recorded or pinned.
- **Test:** `management.test.ts` — credential for user A, `user.current`/`login` answering
  user B; assert `pairs`/`goOnline` do **not** record A's pair, that a second
  `device.restore` returning a different `deviceId` is surfaced as `p2p.identity_mismatch`,
  and (new `enrollment-bootstrap` test) that `enrollWhenMissing` refuses with
  `p2p.device_owner_mismatch` rather than reusing A's device.

---

## 8. A failed pin is only logged, and it is never re-applied: the pair silently stops being connectable

- **Severity: high.** "Paired, listed, and every connect fails" with no message.
- **Evidence:** `electron/main/p2p/management.ts:681-683`
  ```ts
  await session.pairing.pin(serviceId, member, remote.deviceId, this.#lifetime.signal)
    .catch((error) => console.error('[p2p] pair pin failed:', error))
  ```
  `pin` uses `#operation`'s `#busy` guard (`pairing.ts:291`: `p2p.service_busy`) and can also
  fail with `p2p.identity_mismatch` (`manager.go:119-121`), `p2p.network_revoked`
  (`manager.go:127-129`) or `p2p.pair_unauthorized` for a pair in `revokedPairs`
  (`manager.go:130-132`). Once missed, the retry only happens at the next member sync
  (`management.ts:254`, 60 s sweep) and then only if no other failure in the same sync
  aborts earlier (findings 2/5). A helper restart also drops every pin while
  `#restored` (`management.ts:574`) keeps the shell from restoring them again.
- **Symptom:** the pair shows "Member is valid" (`p2p.pairing.stateActive`) yet
  `peer.connect` answers `p2p.pair_unauthorized` (`manager.go:154-158`) and the core ignores
  the peer's offer entirely, so the other side sees only "no answer".
- **Minimal fix:** record the per-pair pin outcome instead of dropping it — extend the
  `#sessions`/`#host` state with `pinFailures: Map<connectionId, code>`, have
  `#syncMembers` **retry the failed pins on the next sweep regardless of whether the row
  changed**, and expose the code in `connections()` so `P2PRunActions.vue` can print it next
  to the failed stage (a locale key `p2p.connect.pinFailed` is missing today).
- **Test:** `management.test.ts` — `pairs.pin` rejects once with `p2p.service_busy`; assert a
  later sweep calls `pairs.pin` again and that the failure code is visible through
  `connections()`/`serviceSessions()`.

---

## 9. `autoConnect.refusal()` is never projected, so "why did it stop" is unanswerable

- **Severity: high** (it is the only diagnostic for the whole retry subsystem).
- **Evidence:** `electron/main/p2p/auto-connect.ts:64-67` defines `refusal()`, and nothing
  calls it: `management.ts:805-807` (`connections()`) returns `this.#host.snapshot()` only, and
  `serviceSessions()` (`management.ts:309-323`) reports only the coordinator session. The
  renderer therefore shows `p2p.connection.stageFailed` (`P2PRunActions.vue:31,57`,
  `RuntimeTabAddMenu.vue:52-77`) with no code and no reason.
- **Symptom:** the run tab and the add-tab menu say "Disconnected"/"Connection failed"; the
  user cannot tell "peer offline" from "authorization gone" from "internal error".
- **Minimal fix:** add `pinRefusals`/`refusals` to the `connections` result
  (`P2PConnectionView` or a sibling `blocked: {serviceId,pairId,code}[]`,
  `src/shared/p2p-management.ts:277-288` and `management-projection.ts:164-172`), fill it from
  `this.#autoConnect.refusal(...)`, and render it in `P2PRunActions.vue` with a new locale key
  `p2p.connect.blockedBy` (en + zh).
- **Test:** `P2PManagementPanel`/`P2PRunActions` test plus a `management-projection.test.ts`
  case asserting the refusal survives projection; main-side test in `management.test.ts`
  asserting `connections()` contains the pair's terminal code after a failed auto attempt.

---

## 10. `TERMINAL_CODES` treats data-shape errors as permanent authorization loss

- **Severity: medium.** A transient validation mismatch disables a pair until the app
  restarts.
- **Evidence:** `electron/main/p2p/auto-connect.ts:31-40` includes `p2p.identity_mismatch` and
  `p2p.trust_restore_rejected`. Both are main-side data-shape refusals that a later successful
  sync can fix (`identity_mismatch` is thrown by `pair-records.ts:141/206/208` and
  `catalog-transition.ts:28/55`), not statements from the coordinator that authorization is
  gone. `#terminal` is only cleared when the pair leaves `wanted` or on
  `clearRefusals()` (`auto-connect.ts:86-88,104-107`), and `management.ts:239` calls the
  latter only from `resumeConnectivity()`. Also note `p2p.lease_rejected`, `p2p.device_revoked`
  and `p2p.unauthorized` are not codes any producer emits (the real ones are
  `p2p.pair_unauthorized`, `p2p.network_revoked`, `p2p.pair_revoked`), so the intended
  authorization stop does not fire while data errors do.
- **Symptom:** a pair stops reconnecting with no visible reason; clicking connect manually
  works again, which reads as flakiness.
- **Minimal fix:** narrow `TERMINAL_CODES` to authorization codes actually produced —
  `p2p.pair_revoked`, `p2p.pair_not_found`, `p2p.pair_unauthorized`, `p2p.network_revoked`,
  `p2p.not_enabled`, `p2p.device_unregistered` — and move `p2p.identity_mismatch` /
  `p2p.trust_restore_rejected` to the retry path (bounded by the existing backoff).
- **Test:** `auto-connect.test.ts` — `connect` rejecting `p2p.identity_mismatch` schedules a
  retry (a 1 s delay is present) and keeps no terminal record; `p2p.pair_unauthorized`
  schedules none.

---

## 11. `#restored` is keyed per service, not per restored device — a credential change is invisible

- **Severity: medium [wedge].** After a re-enroll under a new identity, the shell keeps
  speaking as the old device until the helper restarts.
- **Evidence:** `management.ts:56` (`readonly #restored = new Set<string>()`), `542`
  (early return), `574` (add), `400` (delete only on `removeService`), `970`
  (`#clearSession`). Nothing invalidates it when `completeEnrollment` writes a new credential
  (`credentials.ts:102-131`) or when an account switch changes the credential (finding 7).
  A second `device.restore` is refused with `p2p.invalid_device_state`
  (`networking/internal/helper/host.go:188`) and swallowed at `management.ts:569-573`.
- **Symptom:** right after "re-register this computer", every pair read is `localIsInitiator`
  against the old device id and `pairs.identity` answers `p2p.identity_mismatch`; the pairing
  panel shows an empty list (finding 5) while the harness appears online.
- **Minimal fix:** store `#restored: Map<string, string>` of `serviceId → credential revision`
  (the `PeerCredentialReadback.revision` is already returned by `load`/`completeEnrollment`)
  and let `#readyAsDevice` restore again whenever the stored revision differs. Compare the
  reply's `deviceId` against the credential and refuse `p2p.identity_mismatch` on mismatch so
  the swallow at line 569-573 can never mask a different device.
- **Test:** `management.test.ts` — first `goOnline()` restores device X; rewrite the stored
  credential to device Y (via `PeerCredentialStore` mock) and assert a second `goOnline()`
  issues `device.restore` again and that a reply naming X is refused.

---

## 12. Leaving a network and re-joining the same one lands in "Pending" with no reachable submit action

- **Severity: medium.** The machine is stranded as pending and the join form is gone.
- **Evidence:** `enrollment.ts:217` removes the registered credential on a confirmed leave.
  `management.ts:490-510` (`leaveNetwork`) then refreshes members, but on the *next*
  `goOnline`/`#readyAsDevice`, `enrollWhenMissing` (`enrollment-bootstrap.ts:45-51`) signs in
  and calls `host.register` → `#submit` (`enrollment.ts:262-300`). If the coordinator refuses
  (already-enrolled device, network full, token refusal), the durable pending record stays
  (`credentials.ts:86-99`), which is correct per AGENTS.
  The renderer, however, shows the pending branch with a disabled input and a **Cancel**
  button only (`P2PJoinPanel.vue:326-348`), and the only re-submit/`recover` controls live in
  `P2PEnrollmentPanel.vue:202-219`, gated on
  `state.retryRevision === state.registration.revision` — a value only `p2pEnrollment.recover`
  sets, and only when it fails with `p2p.enrollment_not_found`
  (`p2pEnrollment.ts:157-158`). So after a leave the user has no path back to "Join network".
- **Symptom:** "Waiting for approval" forever after a leave+re-join; the Join form never
  returns (it is rendered only in the `v-else` of `registration.kind === 'pending'`).
- **Minimal fix:** in `P2PJoinPanel.vue`, add the submit/recover actions to the pending
  branch (or link to `P2PEnrollmentPanel`), and expose `retryRevision` through
  `p2pEnrollment.state` whenever `read()` observes a pending record whose server result was
  never confirmed — i.e. set `state.retryRevision = result.data.revision` on a `pending`
  read where `p2p.enrollment_not_found` was previously observed. Add locale keys
  `p2p.myNetwork.resubmitEnrollment` / `p2p.myNetwork.recoverEnrollment` (en + zh).
- **Test:** `P2PJoinPanel.test.ts` — catalog registered → leave → simulated re-join refusal
  leaves pending; assert a submit/resolve control is rendered and that clicking it calls
  `enrollment.submit` with the record's revision.

---

## 13. `peer.left`/`left` networks: `pairing.members()` is service-scoped, so no per-network pruning exists

- **Severity: medium.** Leaving one network can never clean up its computers while the device
  is still in another one.
- **Evidence:** `pairing.ts:75-90` → `pairs.list` with an empty payload → the Go helper calls
  `account.client.Pairs(ctx)` = `GET /v1/pairs` with **no network or user scoping**
  (`networking/internal/helper/management.go:108-113`, `controlplane/management.go:122-126`).
  `recordMembers` therefore rewrites every computer of the service from one undifferentiated
  list, and `leaveNetwork` only marks rows revoked through the *next* sync
  (`management.ts:508-509`), which cannot distinguish "left network A" from "coordinator
  omitted B".
- **Symptom:** after leaving a network, its computer may linger as active (until a sync that
  happens to omit it) or vanish from the list entirely (if the sync fails, finding 4) — the
  list and the coordinator's own "leaving" semantics disagree.
- **Minimal fix:** pass the network into the sync — `PeerPairing.members(serviceId, networkId?)`
  using `NetworkPairs` (`controlplane/user_management.go:115` already exposes the
  owner-scoped `POST` variant), and have `recordMembers` only rewrite rows for the networks
  actually read (`member.networkId`), leaving other networks' rows untouched. Add a
  member-sync scope field so the log/console line names the network.
- **Test:** `member-catalog.test.ts` — a `serviceId`-scoped call must not touch rows of
  another `networkId`; `management.test.ts` — `leaveNetwork(A)` marks only A's rows revoked.

---

## 14. `logout` clears only the in-memory session; the persisted token and the device identity both survive

- **Severity: medium.** Sign-out leaves a usable token on disk and a usable device identity in
  play.
- **Evidence:** `accounts.ts:164-174` deletes `#sessions` entry then calls `user.logout`;
  nothing calls `PeerCredentialStore.removeUserSession` for the logout path (only
  `management.ts:600`, on an *adopted* session the server rejected) and nothing clears the
  device credential (`credentials.ts:194-213` is reachable only from `enrollment.leave`).
  `P2PSelectionStore.forget` (`selection-preferences.ts:67-74`) is never called from
  production code, so `p2p-selection.json` keeps the previous account's choice (harmless only
  because `remembered()` checks `userId`, `selection-preferences.ts:51`).
- **Symptom:** after "Log out" and a restart, `#restoreUserSession` (`management.ts:584-602`)
  silently signs the same account back in from the persisted token; a different account that
  signs in then inherits the old device identity (finding 7).
- **Minimal fix:** on a confirmed `logout`, also `removeUserSession(serviceId)` and
  `selection.forget(serviceId)` (wire `PeerManagement.logout` to do both), and define what the
  device credential means for a signed-out state — either keep it but record its owner
  (`p2p.device_owner_mismatch`, finding 7) or remove it with a new explicit refusal
  `p2p.device_identity_retained`. Add locale keys for the Connect card explaining that the
  device remains enrolled after sign-out.
- **Test:** `management.test.ts` — after `logout`, assert `loadUserSession` resolves
  `undefined` and `remembered()` is empty; restart simulation asserts no auto sign-in.

---

## 15. `memberAsPair` fabricates the pairing panel's identity and presence

- **Severity: medium.** The pairing panel always says "Server reports offline", and its
  `localIsInitiator` may be false — the panel's whole action model keys off that flag.
- **Evidence:** `management-projection.ts:174-214`
  ```ts
  state: 'active' as const,
  expiresAt: 0,
  initiator: { deviceId: computer.localDeviceId, userId: computer.userId, name: computer.displayName,
               fingerprint: fingerprintOf(computer.localPublicKey), presence: 'offline' as const },
  ...
  localIsInitiator: true
  ```
  Both `presence` values are hardcoded `'offline'` and the display name is the *remote's*
  name on both sides; `expiresAt` is `0` for every row; the state is hardcoded `'active'`
  even for a revoked row (`management.ts:712` filters those out, so a revoked pair is
  invisible in the panel while its Run tab says "Revoked" — cf. finding 3 on the same data).
  `P2PPairingPanel.vue:225-227` renders those presences via `p2p.pairing.presenceOnline/Offline`.
- **Symptom:** "Server reports offline" on a peer the device directory shows online; the
  panel's local row shows the remote's name; `localIsInitiator` is claimed rather than read,
  which is the flag `pairing.ts:178-187` uses to pick `approve` vs `confirm`.
- **Minimal fix:** add `pairState` to the panel's projection or filter to
  `computer.pairState === 'active'` **and** surface revoked rows with a distinct copy; store
  the real `localIsInitiator`/`pairId`/`status`/revision in the catalog row (a new
  `coordinatorPairId`, `localIsInitiator`, `presence` field pair) so `memberAsPair` stops
  inventing them; add locale keys `p2p.pairing.stateRevokedLocal` and
  `p2p.pairing.presenceUnknown` for the cases with no data.
- **Test:** `management-projection.test.ts` — project a row whose local side is the target;
  assert `localIsInitiator` is `false` and presence is `'unknown'`/reported value rather than
  a fabricated `'offline'`.

---

## 16. `localDevice()` generates a device id nothing else uses; the UI shows it as "Device ID"

- **Severity: medium.** The identifier a user reads aloud to a colleague (or for support) is
  not the device the coordinator knows.
- **Evidence:** `management.ts:344-363` writes a random `p2p-local-device.json` device id and
  returns it; `P2PJoinPanel.vue:79-83` falls back to it when nothing is registered, and
  `P2PJoinPanel.vue:281-285` labels it "Device ID" beside the enrolled name. The enrolled
  `deviceId` only appears once `registration.kind === 'registered'`
  (`P2PJoinPanel.vue:79-83`), and `networkDevices` uses the *registered* id for `isLocal`
  (`management.ts:441-443`, `management-projection.ts:48`). If the two differ, the device
  directory marks this machine "not local" and `P2PDeviceDirectory.vue:58-60` shows
  `p2p.devices.localAbsent` ("This machine is not in this network") on the machine itself.
- **Symptom:** "This machine is not in this network; enroll it again to return" on the
  machine that is enrolled; the copied Device ID does not match the server's list.
- **Minimal fix:** make `localDevice()` return the enrolled device id when a credential
  exists (read `credentials.loadRegistration`), and label the pre-enrollment value with a
  distinct key (`p2p.myNetwork.localDeviceIdUnenrolled`) plus a locale key
  `p2p.myNetwork.deviceIdNotEnrolled` so the UI never presents an unused id as the device id.
- **Test:** `P2PJoinPanel.test.ts` / `management.test.ts` — with a registered credential whose
  `deviceId` differs from `p2p-local-device.json`, assert the rendered Device ID equals the
  credential's.

---

## 17. A simultaneous sync and a user revocation silently loses the local revoke, and the retry then loops on an unauthorized pin

- **Severity: medium.** "Revoke" appears to succeed, the computer stays connectable, and every
  auto-connect attempt fails.
- **Evidence:** `management.ts:951-960` reads the catalog, rewrites the row, and commits with
  `saved.revision`; a concurrent `recordMembers` commit (`member-catalog.ts:96`) that lands in
  between makes the second commit fail with `p2p.catalog_conflict`
  (`catalog.ts:149-150`; the local path re-reads and compares, the core path returns the same
  code). The `pairing.revoke` call itself already committed server-side
  (`pairing.ts:229-243` → `onPairRevoked`), so the failure surfaces as an unconfirmed write to
  the renderer (`p2pPairing.ts:161-176` treats `p2p.catalog_conflict` as unconfirmed) while the
  local row stays `active`. `revokePair` (`management.ts:753-761`) then returns the catalog,
  which still shows the row active.
- **Symptom:** after revoking while a 60 s sweep is running, the computer stays in the Run
  list as active; auto-connect keeps trying; the user is told the result is unconfirmed.
- **Minimal fix:** make the ownership mutations re-read-and-retry once on `p2p.catalog_conflict`
  inside `#removePairAuthority` / `#removeNetworkAuthority` (loop: `inspect` → build → `commit`,
  at most 2 attempts, then throw) instead of leaving it to the caller; both already hold the
  server-confirmed revocation, so re-applying it locally is safe and idempotent.
- **Test:** `management.test.ts` — make `catalog.commit` fail once with `p2p.catalog_conflict`
  and assert the revoke still lands (a second `inspect`/`commit` pair happens) and the row is
  `revoked`.

---

## 18. Replay guard: a legitimate renderer *can* be refused, and one id is burned by the cap

- **Severity: low** (narrow windows; the guard itself is sound and well tested).
- **Evidence:** `management-requests.ts:73-83`
  ```ts
  if (requestId <= scope.highWater - REPLAY_WINDOW || scope.seen.has(requestId))
    throw new PeerHelperError('p2p.request_replayed')
  scope.seen.add(requestId)
  if (requestId > scope.highWater) scope.highWater = requestId
  ```
  Two windows exist:
  1. `run()` calls `#admit` **before** the pending-cap check
     (`management-requests.ts:26-27`), so the 17th concurrent request is added to `seen` and
     then refused with `p2p.request_limit` — a retry of that exact id (same id reused) would
     be refused as a replay. The renderer always allocates a fresh id
     (`p2pManagement.ts:30-33`), so this is latent, not live.
  2. A scope survives in-place (hash) navigation because `retire()` ignores
     `inPlace === true` (`management-requests.ts:110-112`). A document that resets its own
     counter (any code path re-importing the domain module, or an HMR full reload with the same
     WebContents before `dom-ready`) would then be refused for its first 256 ids. The
     renderer's `sequence` is module-global and never reset (`p2pManagement.ts:28-33`), so
     today this needs an unusual reload.
- **Symptom:** under either window the user sees `p2p.request_replayed` / `p2p.request_limit`
  for a call they just made, with no retry.
- **Minimal fix:** move the `seen.add`/`highWater` update to *after* the pending-cap check (or
  check the cap first), and retire on any navigation whose URL differs from the current
  `senderFrame.url` even when `inPlace` is true. Keep `p2p.request_replayed` as-is otherwise.
- **Test:** `management-requests.test.ts` — (a) fill 16 pending, attempt a 17th, then retry
  the same id and assert it is admitted (not `p2p.request_replayed`); (b) emit
  `did-start-navigation` with `inPlace=true` for a different URL and assert the old document
  is refused afterwards.

---

## 19. `p2p.service_busy` is the only member-sync failure with any retry, and `p2p.not_enabled` after service removal is likewise dropped

- **Severity: low.** (Subsumed by finding 4's fix; listed because it is a separate code path.)
- **Evidence:** `member-catalog.ts:52` — `if (!saved) throw new PeerHelperError('p2p.not_enabled')`;
  `management.ts:640-642` swallows the following `recordMembers` failure into a
  `console.error`, and `management.ts:630-653` swallows everything else. Nothing re-runs the
  sync for a service that was removed locally while a sync was in flight.
- **Symptom:** only a console line; the user sees a stale list until restart.
- **Minimal fix:** as part of finding 4, treat `p2p.not_enabled`/`p2p.service_unconfigured`
  for a service no longer in the catalog as "stop syncing that service" rather than a failure
  (drop it from the sweep list), and report nothing.
- **Test:** `management.test.ts` — remove a service while a sync is in flight; assert no
  further sync attempts for it and no error is recorded.

---

## 20. `pairIdentity` is state-agnostic and `pairs.identity` is claimed authoritative for terminal pairs

- **Severity: low.**
- **Evidence:** `management.ts:715-721` proxies `pairing.identity` for any `pairId` without
  checking `pairState`, while `pair-records.ts` accepts a `revoked` pair. The Go client
  refuses a terminal pair: `PairIdentity` requires `active|invited|approved`
  (`controlplane/management.go:148`), so any browser-side call for a revoked pair fails with
  `p2p.identity_mismatch`, not with a state-specific code. `approve`'s pre-check reads state
  first (`pairing.ts:185-186`) and is fine.
- **Symptom:** a UI action on a revoked pair reports `p2p.identity_mismatch` ("error text names
  the wrong thing") instead of "this pair was revoked".
- **Minimal fix:** in `PeerPairing.identity`, map a coordinator refusal that means "state is
  terminal" to `p2p.pair_revoked`/`p2p.pair_state_mismatch` (both already in
  `P2P_MANAGEMENT_ERROR_CODES`) using the local catalog row's `pairState` as the deciding
  input, so the copy in `p2pRefusalKind` (`p2p-refusal.ts`) reports authorization loss rather
  than a fault.
- **Test:** `pairing.test.ts` — `pairs.identity` refusing `p2p.identity_mismatch` for a pair the
  catalog holds as `revoked` surfaces `p2p.pair_revoked`.

---

## Highest-value three fixes

1. **Make the member sync tolerant and two-way** (findings 1, 2, 3, 5, 6 — all in
   `member-catalog.ts` + `pairing.ts:75-90` + `pair-records.ts:199-212`): skip unusable pairs
   instead of throwing; keep per-row state (not just "was it newly recorded"); mark a row
   revoked when the coordinator reports that remote as terminal, matching by
   `remoteDeviceId`; prune rows whose `localDeviceId` is a dead identity; and give each row a
   distinct `connectionId` when two networks share a peer. Without this, the catalog can
   still wedge on the *next* identity change, and one peer in a second network kills the
   whole service's sync.
2. **Make device identity and account identity agree** (findings 7, 11, 14, 16):
   `enrollment-bootstrap.ts:45` must compare the credential's `userId` with the signed-in
   account (`p2p.device_owner_mismatch`), `#restored` must be keyed by the credential revision
   and the `device.restore` reply's `deviceId` must actually be compared, and a confirmed
   logout must clear the persisted session (and the selection). This is the class of bug that
   makes "which computer am I" and "whose computers do I see" wrong in a way no UI can
   explain away.
3. **Surface, then repair, every silent authorization loss** (findings 3, 8, 9, 10, 17):
   project `autoConnect.refusal()` and the pin failure into `connections()`, render the code
   in `P2PRunActions.vue`/`RuntimeTabAddMenu.vue` with new locale keys, add
   `p2p.pair_unauthorized`/`p2p.network_revoked` to `TERMINAL_CODES` and drop
   `p2p.identity_mismatch`/`p2p.trust_restore_rejected` from it, and retry a stale-revision
   catalog write once. A failure the user cannot see and the shell will not retry is the
   common root of "pairing and connection is unstable".

### Already covered by existing tests (do not re-litigate)

`catalog-transition.ts` rules (`catalog.test.ts:171-234`, `catalog-core.test.ts`,
`networking/internal/catalog/transition_test.go`), the 0.1.38 revoked-instead-of-dropped
convergence (`member-catalog.test.ts:102-131`), the 0.1.36 `internal_error` diagnostics
(`management.ts:277-292`), the replay guard's core behaviour
(`management-requests.test.ts:31-172`), and auto-connect backoff/terminal behaviour
(`auto-connect.test.ts`).

### Untested today (the gaps these findings exploit)

- `member-catalog.ts` with a *pre-existing revoked row* for a remote the coordinator reports
  again (findings 1, 6) — the fixture only ever holds non-revoked or self-rows.
- Two members with the same remote device id and different networks (finding 2).
- `recordMembers` against a catalog that no longer holds the service (finding 19).
- `members()` with a pair whose local device id is neither side (finding 5).
- `#restored` invalidation on a credential change and cross-account credentials (findings 7, 11).
- `pairs.pin` refusal having any consequence (finding 8) — `management.test.ts:370` only asserts
  the pin *was* called.
- `autoConnect.refusal()` reaching a user surface (finding 9).
- The pending-enrollment path after a leave (finding 12).
