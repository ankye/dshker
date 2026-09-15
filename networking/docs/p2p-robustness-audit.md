# DSHKer Go networking core — P2P pairing/connection robustness audit

Scope: `networking/internal/peersession`, `internal/peer/transport.go`, `internal/peer/negotiation.go`,
`internal/controlplane/signals.go` (+ rest of controlplane), `internal/helper` (account lifecycle),
`internal/runtimebridge` (session↔endpoint), `cmd/dshkerd`. Investigation only, no file modified.

Repo: the DSHKer Launcher app repository · module root `networking/` (`github.com/ankye/dshker/networking`)

Notation: `M:line` = `networking/internal/peersession/manager.go`, `T:line` = `internal/peer/transport.go`,
`N:line` = `internal/peer/negotiation.go`, `S:line` = `internal/controlplane/signals.go`,
`H:line` = `internal/helper/host.go`, `R:line` = `internal/localrpc/rpc.go`.

---

## Summary of the answers to the required questions (short form)

| Question                        | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a) Signaling websocket death    | **Nobody notices, nobody resubscribes.** `S.read()` closes `events`; `M.receive` (M:460-513) returns without a log, a state emit, or any recovery; `cmd/dshkerd` never observes it (`helper.Host` has no `signals.Done()` hook). P2P never recovers in-process → app restart. See F1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| b) Session map lifecycle        | Two insert paths (`M:165` reservation, `M:366` start); one delete path (`M:257`, inside `finish`). No path inserts without eventually calling `finish`, **but** `finish` can be delayed arbitrarily (F8) and a reservation exists with no goroutine that can finish it during `Begin` (F4/F8). `close(connection.done)` is _not_ protected against a double call: `close` happens unconditionally under `manager.mu` and `finish` is reachable from two goroutines (Connect's defer and run's defer); the only reason it does not panic today is the `started` flag plus the fact that the flag is written before the offer phase (F8 has the exact race). `<-connection.done` callers (`M:199,205,208,215,227,275`, `network_revocation.go:55`, `M:308`) all block on a goroutine that may not exist yet. |
| c) Deadline coherence           | Incoherent in three places: `run`'s 30s `WaitReady` (M:542) equals ICE's own failure budget (`SetICETimeouts(5s,25s,2s)` → `disconnected+failed = 30s`, pion `agent.go:696,911-926`), so "no path" is a coin flip; the **responder** gets a fresh 30s from `M:495` while the initiator's 30s (M:191) started earlier; and the runtime phase (Establish 70s budget → Probe 10s, `handshake.go:48,162`) has **no** session-level deadline at all, so a full Connect can approach the shell's 90s RPC cap (`R:152`, `rpc.ts:60`). See F6, F7.                                                                                                                                                                                                                                                                 |
| d) Glare                        | Not tolerated and not reported. Each side drops the other's cross attempt; the loser waits 30s and sees `p2p.direct_unavailable`, which is a false statement about the network. See F3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| e) Revocation / identity change | `revoke` (M:442-458) is scoped correctly (pins, endpoint, session cancel) but loses `revokedPairs` bookkeeping that `RevokeNetwork` sets, and does not close `connection.done`; `InvalidateRuntime` (M:278-292) is correct (tests cover it); **revocation is undeliverable whenever signaling is down** (F13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| f) Error naming                 | The manager and the peer transport are mostly disciplined, but `p2p.direct_unavailable` is used as a catch-all for three different physical causes (T:107, T:197, T:252, T:304, N:147), and three distinct _unsolicited/refusal_ situations collapse into "silence then `direct_unavailable`" (F3, F5). See F12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| g) Other                        | Endpoint/run interactions (F9), events-channel head-of-line blocking and the frozen `manager.signals` pointer (F10, F11), account switching leftovers (F14), shell-side retry loop that retries permanent refusals (F16), duplicate success reported as `p2p.connection_cancelled` (F6d).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

# Findings, ordered by severity

## F1 — HIGH — Signaling websocket death silently and permanently disables P2P; nothing ever re-subscribes

**Evidence.**

- Single subscription per manager lifetime, stored in a field written once:
  `M:101-107` `signals, err := client.Subscribe(child, config.Device.DeviceID)` … `manager.signals = signals; go manager.receive()`.
- The reader terminates the channel and the link on the _first_ of many conditions:
  `S:84-92` `defer close(signals.finished); defer close(signals.events); defer signals.cancel(); defer signals.connection.CloseNow()` … `if err != nil || kind != websocket.MessageText { return }`.
  Also `S:97-99` (bad header JSON → `return`), `S:107,116,126` (bad payload → `return`), `S:131-133` (`default: return` for any unknown event type — see F2).
- The manager consumes `for event := range manager.signals.Events()` (`M:461`) and, when the channel closes, simply falls off the end of `receive`:
  `M:510-513` `}` then the comment "Loss of signaling forbids new negotiation, but active data stays until its existing lease expires" — there is **no** log, no `manager.emit`, no retry, no re-`Subscribe`.
- Nothing else can notice: the only subscription in the whole repo is `M:101`; `helper.Host` (H:221) has no `signals.Done()` watcher, and `cmd/dshkerd` only calls `host.Close()` at exit (`main.go:220`). The test driver does read `Signals.Done()` (`integration/process_child_test.go:270-276`) but only to report `ControlOnline` — it never reconnects either.
- After the loss, every attempt fails on a _write_ to the dead socket: `M:194` `manager.signals.Send(deadline, offer)` → `S:151-152` returns `p2p.server_unavailable`; `Connect` then cancels the session (M:197-201). `Begin`, `RenewLease`, `TurnCredentials` still work (plain HTTPS on the same `client`), so the helper looks healthy while negotiation is impossible.

**User-visible symptom.** Pairing/app connect stops working _forever_ after any coordinator hiccup, laptop sleep, or proxy/VPN re-route; the peer that is offering sees `p2p.direct_unavailable`, the initiator sees `p2p.server_unavailable` (or a timeout). Existing sessions keep flowing until the lease expires, then end and can never be rebuilt. Only quitting the app (which restarts `dshkerd`) restores pairing. Auto-connect keeps retrying into the void (F16).

**Minimal fix.**

1. In `Manager.New` (M:107), start a supervisor instead of a bare `go manager.receive()`:
   `go manager.superviseSignals()` which runs `receive()` and, when `manager.signals.Done()` fires, `manager.emit(State{PairID: "", Stage: "signaling-lost", Error: "p2p.signaling_unavailable"})`, logs one line (`fmt.Fprintf(os.Stderr, "signals lost: ...")`), then re-`Subscribe(manager.ctx, deviceID)` with bounded backoff (1s/2s/5s/15s/30s) and restarts `receive()`.
2. Make the pointer swappable: read/write `manager.signals` under `manager.mu` (it is currently read unlocked at M:194 and M:461 and written at M:106/307). Add `func (m *Manager) sender() *controlplane.Signals`.
3. `receive()` must not be restarted before its predecessor stopped, and the new reader must be started with the new `Signals` value (the field, not a captured local).

**Test idea.** Two-peer integration: after `connect(a,b,1)`, stop _only_ the signal path (or have the coordinator close the WSS while HTTP stays up), assert (i) a `peer.state` with `stage == "signaling-lost"` within 5s, (ii) `connect(a,b,2)` succeeds within 20s **without restarting the processes**. Today step (ii) fails forever.

---

## F2 — HIGH — Any unknown websocket event type kills the signaling link (`default: return`)

**Evidence.** `S:101-133`:

```go
switch header.Type {
case "attempt": ...
case "signal": ...
case "revoked": ...
default:
    return     // <-- closes events, cancels ctx, closes the socket
}
```

A single frame of a type this build does not know — a server-side `pong`/keepalive, a `presence`, a newer protocol's `attempt-refused`, a renamed event, a probe — is treated as fatal and tears down the whole subscription with no diagnostic. Contrast with a malformed JSON _header_ (also `return`, S:97-99): neither path logs, and neither is distinguishable from a clean close.

**User-visible symptom.** Pairing dies silently (as F1) after a coordinator deploy that adds an event kind; the user only sees `p2p.direct_unavailable`/`p2p.server_unavailable` and restarts the app.

**Minimal fix.** In `S:131`, replace `return` with a logged skip: `fmt.Fprintf(os.Stderr, "signals: ignoring unknown event type %q\n", header.Type); continue`. Keep `return` only for structurally undecodable frames, and log those too (`"signals: undecodable frame"`).

**Test idea.** Table test on `Signals.read` with a scripted websocket (the `controlplane` tests already have a TLS fixture, see `client_test.go:60`): send one unknown type, then a valid `signal`; assert `events` delivers the signal and `Done()` stays open.

---

## F3 — HIGH — Glare is neither tolerated nor reported: the losing attempt is silent, then blamed on the network

**Evidence.**

- Both sides start their own attempt: `Connect` (M:142-232) is not aware of an incoming opposite-direction attempt.
- The incoming `attempt` is refused at `start` (M:331-334 `return nil, errors.New("p2p.connection_busy")`) and the refusal is only printed:
  `M:466-471` `if _, err := manager.start(pairID, event.Lease, nil); err != nil { fmt.Fprintf(os.Stderr, "start %s: %v\n", pairID, err) }` — nothing is sent to the coordinator or to the peer.
- The incoming `signal` for that lost attempt matches no session and is dropped with no trace:
  `M:478-487` `connection := manager.sessionByAttemptLocked(event.Signal.AttemptID)` … `if !negotiating { continue }`.
- The losing side therefore keeps gathering/sending for its full budget and ends at `T:252`/`T:107` `p2p.direct_unavailable` → `namedRefusal` (M:240-251, `transportReady` false) → `"p2p.direct_unavailable"`.

**User-visible symptom.** "Pairing is unstable": a click sometimes reports _"the computers cannot reach each other"_ while the other side is in fact connected and reachable — a false network diagnosis; the retry succeeds a second later, which trains users to click twice.

**Minimal fix.** Send the refusal instead of swallowing it. Add a `manager.reject(pairID, lease, code)` helper that builds a signed `protocol.Signal{Type:"reject", AttemptID: lease.AttemptID, ...}` on the _remote's_ attempt scope (the same shape `gather` builds, N:92) and `manager.signals.Send(ctx≤2s, signal)`; call it from `M:468-470` (`p2p.connection_busy` / `p2p.glare`) and from `M:485-487` when a `signal` matches no session (`p2p.attempt_unknown`). Log both with attemptID and remote device id so the current silent drop is at least diagnosable. (Server-side cooperation is out of this module; a peer-visible `reject` signal is enough for the loser to fail fast with a named code.)

**Test idea.** Two managers, one coordinator: call `Connect` on both simultaneously for the same pair; assert that within 5s the loser receives a _named_ `p2p.glare`/`p2p.connection_busy` (or that one direction wins and the other role degrades to a responder session), never `p2p.direct_unavailable` after 30s.

---

## F4 — HIGH — A revoked/torn-down pair wedges `Connect` callers for the full lease TTL (65s) because the session loop can never reach `ready`

**Evidence.** `Connect` blocks on a select that only unblocks on `ready`, `connection.ctx`, or the caller's ctx (M:202-231). `connection.ready` is closed _only_ at M:610, after `transport.WaitReady` (M:543) and after up to 10s of `Probe`. If the pair is revoked while the caller waits:

- `revoke` (M:442-458) cancels the session and closes the endpoint. The endpoint closure wakes `run` **only if** it already reached the final select (M:618) — during `WaitReady`/`Establish`/`Probe` the endpoint is not consulted at all.
- The session's own ctx is a child of `manager.ctx` (M:85, M:163) — it is _not_ cancelled by revocation, because `revoke` calls `connection.cancel()` (M:449), which **does** cancel it. So the `WaitReady` returns with `ctx.Err()`… and then the failure path still runs `manager.end(connection.lease)` (M:528, 10s HTTP), `runtimeOwner` returns `p2p.runtime_invalidated`, and `finish` deletes the entry. So the _revoked_ case does eventually settle, but:
- the case that does **not** settle is the **network-revoked / unpinned** case where nothing cancels the session: `RevokeNetwork` (network_revocation.go:45-56) only collects sessions whose pair is in `revokedPairs`; a session whose pin was already deleted by an earlier `revoke` signal, or a pair that became unauthorized server-side, is not in any map and keeps running to the natural ICE-lease end; and
- the reservation itself has **no deadline**: a session entry exists (M:165) while `Begin` (M:181) and `start` (M:324-359, including the TURN fetch) run. `Begin` has only the HTTP client's 10s (`client.go:56`), no session-level bound.

**User-visible symptom.** A connect clicked right after a revoke/leave can hang for the whole lease TTL; the shell's `Connections#busy` is released when the RPC returns (`rpc.ts:60` 90s, `connections.ts:105-111`), so the UI can appear free while the helper still holds `connection_busy` (F5).

**Minimal fix.** Bound the whole attempt: give the session a hard generation deadline at reservation time — in `Connect` after `newSession`, `deadline, cancel := context.WithTimeout(connection.ctx, 45*time.Second)` and derive the offer/`WaitReady`/`Establish` contexts from it (replacing the ad-hoc 30s at M:191 and M:542), and have `run`'s defer `report` (`state.Error = "p2p.attempt_timeout"`) — or, minimally, add `case <-connection.ctx.Done()` around the `Establish`/`Probe` region (M:549-592) so a cancelled session stops before the runtime phase.

**Test idea.** `peersession` unit test with a stubbed `client`: reserve a session, delete the pin (simulating an out-of-band revocation), never answer the offer; assert `Connect` returns a named refusal within ≤45s **and** `manager.sessions` is empty afterwards. Today the map entry survives until ICE fails.

---

## F5 — HIGH — The caller's deadline fires, but the session keeps running and blocks every retry with `p2p.connection_busy`

**Evidence.**

- Reservation precedes everything: `M:163-166` `connection := newSession(manager.ctx); manager.sessions[pairID] = connection` — the map entry exists before `Begin`, before `start`, before any transport.
- The next `Connect` is refused purely on map presence: `M:159-162` `if _, exists := manager.sessions[pairID]; exists { return Connected{}, errors.New("p2p.connection_busy") }`.
- Giving up does **not** release early; it _waits_: `M:202-209`
  ```go
  case <-ctx.Done():
      connection.cancel()
      <-connection.done            // blocks until run()'s defer completes
      return Connected{}, ctx.Err()
  ```
  `<-connection.done` is satisfied only by `finish` (M:259), which runs in `run`'s defer (M:540) _after_ `connection.transport.Close()` (M:522) and `<-renewed` (M:523). `renew` can be inside an HTTP call with a 10s client timeout (`M:663` → `client.go:56`), and `Probe` adds 10s (`handshake.go:162`, called at M:588).
- The shell aborts its JS promise on `AbortSignal` (`rpc.ts:59`) but the request frame is already on the wire; the helper only stops at the **90s** handler deadline (`R:152`, `peer.handle`) or `rpc.ts:60`. So "caller cancelled" is invisible to the Go side for as long as 90s.
- The auto-connect retry loop treats this as transient: `auto-connect.ts:31-40` `TERMINAL_CODES` does not contain `p2p.connection_busy`, so it reschedules (1s,2s,5s,15s,60s).

**User-visible symptom.** Precisely known symptom 1: "a failed connect attempt can leave a session in `Manager.sessions` for tens of seconds, so every auto-connect retry is refused with `p2p.connection_busy`". The user sees a pair stuck in "connecting" and no tab; a manual second click also fails.

**Minimal fix.** Two small changes:

1. In `Connect`, replace `<-connection.done` on the caller-cancelled paths with a bounded, non-blocking release: after `connection.cancel()`, `select { case <-connection.done: case <-time.After(2*time.Second): }` and return `p2p.connection_cancelled` immediately — the session self-cleans in the background; the retry path is unblocked by (2).
2. Make the busy check generation-aware so a _newer_ attempt supersedes a dead reservation instead of being refused: in `M:159-162`, when the existing session is not past the transport stage (`connection.transport == nil`) or its `Generation < generation`, cancel and replace it rather than returning `p2p.connection_busy` (the caller passes a monotonically increasing `generation`, `connections.ts:41`). This also removes the observed 30s wedge without changing the reservation design that `TestDisconnectCancelsPendingBegin` depends on.

**Test idea.** Unit test with a stubbed coordinator that answers `Begin` then stalls the signal `Send`: start `Connect` with a 1s ctx, cancel it, then immediately call `Connect` again and assert it is **not** refused with `p2p.connection_busy` (generation 2 > generation 1).

---

## F6 — MEDIUM-HIGH — Deadline coherence: 30s session deadline == ICE's 30s failure budget, one-sided negotiation budget, and no session deadline over the runtime phase

**Evidence.**

- `T:130` `engine.SetICETimeouts(5*time.Second, 25*time.Second, 2*time.Second)`. In pion/ice v4.4.0 the second value is added to the first: `agent.go:911-914` `totalTimeToFailure := a.failedTimeout; if != 0 { += a.disconnectedTimeout }`, and the checking loop fails the same way: `agent.go:696` `if time.Since(checkingDuration) > a.disconnectedTimeout+a.failedTimeout { ConnectionStateFailed }` → **30s** to `failed`, which maps to `transport.fail("p2p.direct_unavailable")` (T:192-197).
- `M:542` `deadline, cancel := context.WithTimeout(connection.ctx, 30*time.Second)` — **the same 30s**. Whichever wins, `WaitReady` returns `ctx.Err()` or `direct_unavailable`, and both are collapsed to the same refusal (M:244-249). A path that would have come up at 29.9s is reported as "no direct path".
- Responder side has an _independent_ 30s starting later: `M:495` `ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second)` for `AcceptOffer` + answer `Send`. If the receive loop is behind (see F10), the responder's window starts seconds after the initiator's and can end after the initiator has already given up.
- The runtime phase has **no** session deadline: `handshake.go:48` uses a 70s budget derived from `sessionCtx` (which itself is the caller ctx — `Connect` passes `connection.ctx` at M:562, so 70s is the cap), `Probe` adds 10s (`handshake.go:162`), `M:528` `end` adds 10s (`M:263`), all unchanged by the caller's 90s host budget (`R:152`) and 90s shell budget (`rpc.ts:60`). With the 30s offer + 30s ICE + 70s Establish + 10s Probe, a single `peer.connect` can exceed the shell's 90s cap and be reported as `p2p.request_timeout` (rpc.ts:60) with a session still running.

**User-visible symptom.** Intermittent, unreproducible "the computers cannot reach each other" that succeeds on retry; and occasional 90s UI hangs where the shell says timeout while the helper is still working.

**Minimal fix.**

1. Decouple the sign of the race: raise the transport's ICE failed timeout so ICE cannot pre-empt the caller, e.g. `SetICETimeouts(5s, 30s, 2s)` (ICE failure at 35s) while the session offers/waits at 30s, so the _session_ owns the timeout; or lower `run`'s `WaitReady` deadline to 25s. Either way, one constant must be strictly smaller and the two must be defined next to each other with a comment.
2. Bound the negotiation budget on the responder by the offer's own `ExpiresAt` (`protocol.SignalExpiry`, `signal.go`), not a fresh 30s: `ctx` deadline `= min(now+15s, offer.ExpiresAt)`.
3. Put one attempt-level deadline in `run` (F4's fix) that covers `Establish`+`Probe`+`end`, e.g. 45s total, and emit `p2p.attempt_timeout` when it fires so the code is distinguishable from `direct_unavailable`.

**Test idea.** Table test asserting the invariant `offerDeadline < iceFailedBudget` and `attemptDeadline < shellBudget` by reading the constants from `peer`/`peersession`/`localrpc` in one test (fails today: 30s == 30s). Plus a delayed-answer test: hold the answer for 5s and assert the initiator still reaches `ready`.

---

## F7 — MEDIUM-HIGH — `p2p.direct_unavailable` is a catch-all that hides the real cause (transport, ICE gave up, no UDP candidate pair, SDP candidate rejected, and "the peer never answered")

**Evidence.**

- `T:107` grace-window expiry, `T:197` connection state failed/closed → `p2p.direct_unavailable`.
- `T:252` session ctx cancelled while waiting → `p2p.direct_unavailable` (this is what a _deliberate_ teardown looks like, not a network failure).
- `T:304` `Path()` finds no selected UDP candidate pair → `p2p.direct_unavailable` — this fires at `T:211-215` in `OnOpen` even when ICE/DTLS succeeded.
- `N:146-148` a _remote SDP_ whose candidate is not UDP → `p2p.direct_unavailable` (a protocol/offer-shape failure, not a reachability failure).
- `M:240-251` `namedRefusal` then forwards that code, and `M:604` treats anything before stage `starting-runtime` as "transport failure" → the user is told "no direct path" for all of the above.
- Conversely, the case that is _really_ "the remote never answered / glare / unknown attempt" produces no code at all on the responder side (F3) and `direct_unavailable` on the initiator.

**User-visible symptom.** Misleading error: users are told the networks cannot reach each other when the cause is a rejected candidate, a torn-down session, or a dropped offer.

**Minimal fix.** Split the four `direct_unavailable` sites into distinct codes and add them to the shell vocabulary: `p2p.ice_failed` (`T:197`), `p2p.ice_no_udp_pair` (`T:304`), `p2p.signal_candidate_rejected` (`N:147`), and keep `p2p.direct_unavailable` only for the grace-window expiry (`T:107`). At `T:252` return `p2p.connection_cancelled` when `transport.ctx` was cancelled by our own close (check a `closed` flag) instead of `direct_unavailable`.

**Test idea.** Unit tests per site asserting the error code (`TestWaitReadyReportsCancellationAsCancelled`, `TestPathWithoutUDPPairIsNotDirectUnavailable`), plus an SDP fixture with a TCP candidate asserting `p2p.signal_candidate_rejected`.

---

## F8 — MEDIUM-HIGH — `finish` is not idempotent and can be reached by two goroutines; the only guard is a flag written before the race window opens

**Evidence.** `M:169-174` and `M:185-190`:

```go
started := false
defer func() { if !started { manager.finish(pairID, connection) } }()
...
_, err = manager.start(pairID, lease, connection)
if err != nil { manager.end(lease); return Connected{}, err }   // started still false → defer finishes
started = true                                                  // line 190
```

`finish` (M:253-261) unconditionally does `close(connection.done)` under `manager.mu`. `run`'s defer calls `finish` too (M:540). The flag is set **after** `start` returns, and `start` has already done `go manager.run(connection)` (M:367) before returning. The window between the goroutine start and `started = true` is small but real: a coordinator error/cancel that makes `run` fail instantly plus a concurrent caller cancellation (`context.AfterFunc(ctx, connection.cancel)` at M:167 fires at any moment) can produce `finish` from `run`'s defer **and** from `Connect`'s defer. `close` on a closed channel panics, which in `dshkerd` is a process crash (`main.go:53-56` prints and exits).

**User-visible symptom.** Rare, unreproducible helper crash — the whole launcher loses P2P and the DSH child (`defer runtimeSupervisor.Shutdown()`, main.go:187) until restart.

**Minimal fix.** Make the release exactly-once: add `finishOnce sync.Once` to `session` (M:66-82) and have `finish` perform `cancel`, map delete and `close(done)` inside `connection.finishOnce.Do(func(){ ... })`; keep the map-identity check inside the `Do`.

**Test idea.** Deterministic unit test: call `manager.finish(pairID, connection)` twice (and once from a `run` stub) and assert no panic (`TestFinishIsIdempotent`). Today a second call panics.

---

## F9 — MEDIUM — Account switching at the core leaves the previous account's manager, client, pins, sessions and endpoints alive

**Evidence.**

- The manager is created once per account and never replaced: `H:188` `if protocol.Decode(data, &request) != nil || account.manager != nil { return nil, errors.New("p2p.invalid_device_state") }`, `H:226` `account.client, account.manager, account.device = client, manager, request.Device`.
- `service.configure` keys accounts by `identity.ServiceID` and only ever _returns early_ for a known one: `H:171-179`. A configure with a different service id creates a **second** `account` and leaves the first one in `host.accounts` with a live `manager`.
- The only place an old manager is closed is process shutdown: `H:57-76` `Host.Close()`; `dshkerd` calls it at the very end (`main.go:220`). `user.login`/`user.logout` (H:26, `user_management.go:23-24`) and `network.leave` (`user_management.go:75`) never touch a manager.
- Consequences while the old account lingers: its sessions keep `renew` ticking (M:655), its `endpoints` keep loopback listeners and stable URLs alive (`M:60`, `H:221` manager outlives the account), and its pins keep answering incoming `attempt` events (`M:413-424`).

**User-visible symptom.** After signing out / switching accounts, a browser tab pointed at the old account's peer URL keeps working; the old device identity keeps a P2P session and renews its lease; a service left behind still consumes sockets. Only a restart cleans it up.

**Minimal fix.** Give `account` an explicit teardown and call it (a) when `service.configure` is asked for a _new_ service while another account is the active one — or at least on `user.logout` (`H:126-128` routing) — and (b) when `Host.Close` runs; body: `if account.manager != nil { account.manager.Close(); account.manager = nil }` then `account.client.Close()`. Add a `helper` method `account.release()` and call it from `userManagement`'s `user.logout` case.

**Test idea.** `helper` test: `service.configure` for account A, `device.restore`, `peer.connect`; then `service.configure`/`user.logout` for a new identity; assert the old manager's `Close()` was called (observable as the old `peer.state` ending and the endpoint's `Done()` firing) and that no session goroutine remains.

---

## F10 — MEDIUM — One `Signals` pointer read unlocked + a 32-slot channel + serial handlers = head-of-line blocking and stale-link writes

**Evidence.**

- `manager.signals` is written once (M:106) and read unlocked from `Connect` (M:194) and `receive` (M:461, 501). There is no `sender()` accessor and no lock, so any future resubscribe (F1) races with in-flight `Send`s.
- Handlers run inline in the single `receive` goroutine: `M:495-506` `ctx, cancel := context.WithTimeout(connection.ctx, 30*time.Second); answer, err = connection.transport.AcceptOffer(ctx, event.Signal); if err == nil { err = manager.signals.Send(ctx, answer) }`. While one pair negotiates (up to 30s), **every other pair's** `attempt`/`signal`/`revoked` event waits behind it.
- The queue is only 32 deep (`S:57` `events: make(chan SignalEvent, 32)`); when it fills, `S:134-138` blocks the reader, which stops the socket's read loop (so pong/keepalive handling stalls) until the handler finishes.
- A `revoked` event for a _different_ pair also waits behind the negotiation (M:475-477).
- `Connect`'s `Send` uses the 30s `deadline` (M:191-195) on the same socket as the receive loop's `Send` (M:501), serialized by `writeMu` (S:145-146).

**User-visible symptom.** With 3+ pairs, connecting one pair delays/stalls revoked handling and other pairs' connects; a revoked network can stay reachable for the duration of an unrelated negotiation; under load, events queue and the signaling socket stops reading.

**Minimal fix.** (1) Spawn per-event handling: in `receive`, dispatch `offer` handling to `go func(connection *session, signal protocol.Signal){...}` with a per-session in-flight guard (`connection.mu` + `negotiating bool`) so two signals for the same attempt cannot race; keep `revoked` inline (it is cheap). (2) Add `func (manager *Manager) sender(ctx) *controlplane.Signals` that reads the field under `manager.mu`. (3) Raise `S:57` buffer to e.g. 256 — cheap and removes the reader stall for realistic bursts.

**Test idea.** Start negotiations on 3 pairs with a stubbed slow `AcceptOffer` for pair 1; assert pair 2's `signal` is answered within 1s and a `revoked` event for pair 3 is processed immediately (today it waits out pair 1's 30s).

---

## F11 — MEDIUM — A `revoked` signal cancels the session but does not record the pair in `revokedPairs`, and `Connect`/`Pin` disagree about which code to give

**Evidence.**

- `RevokeNetwork` records both maps: `network_revocation.go:25` `manager.revokedNetworks[networkID] = struct{}{}` and `:33` `manager.revokedPairs[pairID] = networkID` (and uses the latter to find sessions at `:45-49`).
- The signal-driven `revoke` does neither: `M:442-451` `delete(manager.pins, pairID); endpoint := manager.endpoints[pairID]; delete(manager.endpoints, pairID); connection := manager.sessions[pairID]; if connection != nil { connection.cancel() }` — `revokedPairs` is untouched.
- Therefore a coordinator `revoked` for a pair whose session is in the _reserved_ state (F5) is not necessarily collected by a later `RevokeNetwork` for the same network, because `M:45-49`'s filter is `manager.revokedPairs[pairID] == networkID`.
- Also, `Pin` (M:127-132) reports `p2p.network_revoked` vs `p2p.pair_unauthorized` from two different maps, while `Connect` (M:154-158) always reports `p2p.pair_unauthorized` for a missing pin — the same user action can surface two different codes depending on which call ran first.

**User-visible symptom.** Inconsistent refusals for "this pair/network is revoked"; occasional failure to tear down a reserved session during a network revocation.

**Minimal fix.** In `revoke` (M:442), record `if manager.revokedPairs == nil { ... }; manager.revokedPairs[pairID] = pin.Pair.NetworkID` before `delete(manager.pins, pairID)` (read the pin first). Keep the codes as they are but document the mapping in one place, or make `Connect` consult the same maps (it currently can only see `pins`).

**Test idea.** Extend `TestRevocationClosesTheEndpoint` (`endpoint_lifetime_test.go:55`): after `manager.revoke(pairID)`, insert a reserved session for the same pair and call `RevokeNetwork(network)`; assert the reserved session is cancelled and `pins`/`endpoints` are empty.

---

## F12 — MEDIUM — Re-joining the same network is permanently refused in-process (`revokedNetworks`/`revokedPairs` are write-only)

**Evidence.**

- The only writes: `network_revocation.go:21-25` and `:33`. The only reads: `M:127-132` (`Pin`). `grep` for `delete(manager.revoked` / assignment returns nothing anywhere in the module — nothing clears them.
- `Pin` refuses at M:127-132: `if _, revoked := manager.revokedNetworks[pin.Pair.NetworkID]; revoked { return errors.New("p2p.network_revoked") }` / `if _, revoked := manager.revokedPairs[pin.Pair.PairID]; revoked { return errors.New("p2p.pair_unauthorized") }`.
- Confirmed intentional-but-terminal by the code comment `network_revocation.go:10-11` ("RevokeNetwork is irreversible for this helper lifetime") and asserted by tests `network_revocation_test.go:36-43` and `integration/network_revocation_test.go:44-50`.
- There is no path to a fresh `Manager`: `H:188` refuses a second `device.restore` per account, and `host.Close` is the only manager teardown. So clearing revocation requires a new `dshkerd` process.
- The shell hits this on the normal leave/re-join flow: `electron/main/p2p/enrollment.ts:210-217` (`network.leave` → credentials removed) and `management.ts:49-75`/`490-510` (`leaveNetwork`), then re-enrollment into the same network id; the re-pin then refuses on every sync (`management.ts:672-684`, `pairing.pin` → `pairs.pin` → `account.manager.Pin`, `management.go:168-173`), and the refusal is only logged (`management.ts:683` `console.error('[p2p] pair pin failed:', error)`), while the catalog row stays `active` (`management.ts:685`, `recordMembers`).

**User-visible symptom.** "Leave the network, re-join (same network id), and the computers never connect again": the member list still shows the peer as active, `Connect` returns `p2p.pair_unauthorized`, and the only recovery is restarting the launcher. The shell's auto-connect also never gives up (`p2p.pair_unauthorized`/`p2p.network_revoked` are not in `TERMINAL_CODES`, `auto-connect.ts:31-40`), so it retries forever at 60s intervals.

**Minimal fix.** Make revocation tied to the _authorization_ rather than terminal for the process: add a scoped operation that clears the two maps for a network that the coordinator has re-authorized, e.g. extend `Manager.Pin`'s guard so a pin whose `Pair.State == "active"` and `Revision` is **strictly greater** than the revision that was revoked clears `revokedPairs[pairID]` (and `revokedNetworks[networkID]` when no other revoked pair remains in it); or add `Manager.RestoreNetwork(networkID)` called from a new `network.restore` helper method invoked by the shell on successful re-enrollment. Keep the strong invariant for a _genuinely deleted_ network by keeping the map until the coordinator issues a new pair revision.

**Test idea.** Integration (real coordinator): create network → enroll A,B → pin → connect → `DeleteNetwork` + `RevokeNetwork` → re-enroll both devices into the **same** network id → assert `Pin` and `Connect` succeed. Today it fails with `p2p.network_revoked` forever.

---

## F13 — MEDIUM — A `revoked` event that is never delivered is never recovered: revocation is one-shot, unacknowledged, and lost with the signal channel

**Evidence.**

- `revoked` is delivered only as a websocket event: `S:120-130` parses it, `M:475-477` applies it (`manager.revoke(event.PairID)`), `M:488-490` cancels a session already in the map.
- There is no REST/periodic re-check of pair authorization: `renew` (M:655-673) only calls `RenewLease` and treats only four codes as terminal (`M:646-653` — `p2p.pair_unauthorized`, `p2p.device_unauthorized`, `p2p.lease_scope_mismatch`, `p2p.identity_mismatch`); a coordinator that keeps answering `RenewLease` normally (because revocation was queued as an event) lets the session run on.
- If the signal link is down (F1), the event is lost: the peer keeps its pin, keeps its session until the lease expires, and — crucially — keeps `pins[pairID]`, so after expiry `Connect` can attempt again through HTTP (`Begin` is plain HTTPS) and only fails at `signals.Send`. There is no local re-verification that the pair still exists.
- Nothing garbage-collects a pin whose pair no longer exists server-side: `pins` is only mutated by `Pin` (M:138), `revoke` (M:444) and `RevokeNetwork` (`:32`).

**User-visible symptom.** A device that was revoked by another device keeps its pinned state and keeps retrying; with signaling down it never learns and the pair stays "reachable" in the UI. The stale pair is only cleared by a restart or by the server's next successful event.

**Minimal fix.** Make revocation observable rather than only push-delivered: in `Manager.renew` (M:662-670), when `RenewLease` returns `p2p.pair_not_found`/`p2p.pair_revoked`/`p2p.pair_unauthorized` (add those to `renewRefusal`, M:646-653), call `manager.revoke(connection.PairID)` instead of only `connection.cancel()`. Additionally, when signaling is re-established (F1's supervisor), do one authorization re-check per pinned pair (e.g. `PairIdentity`) and `revoke` the pairs the coordinator reports as gone/revoked — this also bounds any future pin leak.

**Test idea.** Two-peer integration: connect A,B; kill B's signal websocket only; revoke the pair server-side (A's `revoked` arrives, B's is queued/lost); assert B's `Connect` attempt after lease expiry fails with `p2p.pair_authorized`-class refusal and B's `pins` no longer contains the pair. Today B keeps the pin indefinitely.

---

## F14 — MEDIUM — The requester's `Connect` keeps its session alive after the caller abandoned, so `Disconnect` (the user's cleanup) blocks instead of cleaning

**Evidence.** `M:267-277`:

```go
connection, exists := manager.sessions[pairID]
if !exists { return errors.New("p2p.not_connected") }
connection.cancel()
<-connection.done
```

`Disconnect` has no timeout and no way to force the map entry out; if the session goroutine is in `Establish`/`Probe`/`Close` (F4, F5), the shell's "Disconnect" button blocks up to its 90s budget and then reports `p2p.request_timeout` (`rpc.ts:60`) — naming a timeout rather than "the connection could not be torn down". `peer.disconnect` also drops the local entry URL first (`connections.ts:65`), so the UI has already forgotten the URL while the helper still holds the session and its endpoint.

**Minimal fix.** Bound it: `select { case <-connection.done: return nil; case <-time.After(5*time.Second): manager.forceFinish(pairID, connection); return errors.New("p2p.disconnect_timeout") }` where `forceFinish` removes the map entry and closes `done` via the `finishOnce` (F8). Return the named code so the shell can surface a retry instead of a generic timeout.

**Test idea.** Unit test: a session whose transport `Close` never completes (stub) — assert `Disconnect` returns `p2p.disconnect_timeout` within ~5s and `manager.sessions` no longer contains the pair.

---

## F15 — LOW-MEDIUM — `InvalidateRuntime` relies on an unsynchronized read of `result.State.RuntimeGeneration` semantics and can cancel a session whose runtime is merely not yet bound

**Evidence.** `M:278-292`: `if connection.transport == nil || connection.lease.ToDeviceID != manager.config.Device.DeviceID { continue }` then `matches := connection.result.State.RuntimeGeneration == 0 || connection.result.State.RuntimeGeneration == generation`. A zero value (the session has not yet recorded its binding — e.g. still in `Establish`, or the owner callback has not run) **matches any generation**, so a runtime invalidation from an unrelated generation cancels a pending attempt. The lifecycle tests cover the intended cases (`lifecycle_test.go:86-137`) but not the `== 0` branch against a live-but-unbound session.

**User-visible symptom.** An unrelated `runtime.invalidate` (e.g. a DSH restart generation bump) aborts an in-flight connect, surfacing as `p2p.connection_cancelled`; the retry then has to fight F5.

**Minimal fix.** Treat "unknown" as no-match on invalidation of in-flight attempts: require `connection.result.State.RuntimeGeneration != 0 && == generation` to cancel, and let the `runtimeOwner` closure's own check (M:630-634, `owner` result rejected with `p2p.runtime_invalidated`) handle the race for an unbound session. Optionally skip sessions whose `connection.ready` is not yet closed.

**Test idea.** Unit test: an incoming session with `RuntimeGeneration == 0` and `true` for `transport != nil`; call `InvalidateRuntime(7)`; assert the session is _not_ cancelled before its owner binding resolves, and that a later binding of generation 7 is rejected.

---

## F16 — LOW-MEDIUM — Shell auto-connect retries permanent condition codes forever, and `stage()` keeps a pair in a "live" stage after a dead session

**Evidence.** `electron/main/p2p/auto-connect.ts:31-40` `TERMINAL_CODES` — missing `p2p.network_revoked`, `p2p.pair_unauthorized`, `p2p.not_connected`, `p2p.connection_busy`, `p2p.device_unregistered`, `p2p.signaling_unavailable` (which does not exist yet, F1). Any other code is rescheduled with the widening backoff up to 60s (`:151-161`). `LIVE_STAGES` (`:27`) is `punching|starting-runtime|ready`; the manager emits `disconnected`/`failed` only from `run`, so a session wedged in F4/F5 has already emitted `punching` (M:518-519) and `stage()` reports a live stage, making `#ensure` skip the pair entirely (`:121-126`) — the pair looks "connecting" indefinitely.

**Minimal fix.** Add the authorization codes to `TERMINAL_CODES` and surface `refusal()` so the UI can show "re-authorize this pair" instead of an eternal spinner; in the Go core, emit a terminal state (`stage: "failed"`, error code) whenever the session's hard deadline (F4) fires, so `stage()` stops claiming `punching`.

**Test idea.** `auto-connect.test.ts`: `connect()` rejects with `p2p.network_revoked` → assert no timer is scheduled and `refusal()` returns it.

---

## Also explicitly checked and **handled correctly** (no finding)

- **`Signals.read` → `receive` teardown ordering**: `S:85-88` closes `finished` before `events`, `receive`'s `range` terminates, `Manager.Close` (`M:307`) joins via `<-signals.finished` — no goroutine leak on an orderly close.
- **`Pin` identity continuity** (`M:111-140`): network/revision/user/key/binding changes are refused, key bytes are copied (`M:136-137`), covered by `manager_test.go`.
- **`start`'s reservation identity check** (`M:331-337`) and cross-side lease/device checks (`M:344-349`) are correct, including the incoming-attempt asymmetry; `peer/transport_test.go` and the admission tests cover the scope validation.
- **`revoke` closes the endpoint outside `manager.mu`** (`M:452-457`) — comment and `endpoint_lifetime_test.go` cover it; endpoint-lifetime-vs-session-lifetime behavior (`M:529-539`, `endpoint.go:83-94`) matches its documented intent.
- **`renewRefusal` + `Transport.enforceLease`** (`M:646-653`, `T:327-349`): the local lease timer is the backstop when the coordinator is unreachable, and the soak test (`stability_test.go:69-128`) exercises it.
- **Grace window** semantics (`T:95-121`, `T:190-210`): do-not-extend, cancel-on-recover, drop-on-close are all correct and covered by `grace_test.go`.
- **`peerbroker` / `remoteroute`**: verified they do not interact with peer sessions at all — `remoteroute.Route` owns SSH generations only (`route.go:16-34`), `peerbroker.Holder` owns one HTTP endpoint (`holder.go`). No session-lifecycle coupling to report.
- **`cmd/dshkerd`**: constructs the manager through `helper.Host` (`main.go:195`, `H:221`) and only closes it at exit (`main.go:220`); it has no path to re-subscribe (this is F1's context).

## Untested today (worth stating plainly)

`peersession` has tests for pin validation, endpoint lifetime, invalidation scoping, disconnect-during-Begin, and network revocation; `integration/` has load, soak, reconnect, kill, revocation and failure-code tests. **Nothing** covers: signal-websocket death without a process restart, unknown signaling event types, glare, `finish` idempotency, `Connect` with a dead signal link, the 30s==30s deadline relation, `Disconnect` on a wedged session, account switching/logout, network re-join, or lost-`revoked`.

---

# Highest-value three fixes

1. **Signal-loss supervision and resubscribe (F1 + F2 + F10-partial).** One supervisor around `manager.receive()` that logs, emits `p2p.signaling_unavailable`, and re-`Subscribe`s with backoff; `S:131` must skip unknown event types instead of returning; read `manager.signals` through a locked accessor. This converts "restart the app to pair again" into a transient blip, and it is the fix every other push-delivered guarantee (revocation, glare refusals, answer delivery) depends on.

2. **One bounded attempt with generation-aware supersession (F4 + F5 + F14).** Put a hard deadline on the whole attempt (offer → ICE → runtime), give `finish` a `sync.Once` (F8), let a newer `generation` supersede a dead reservation, and bound the waits on `<-connection.done` in `Connect`/`Disconnect` with a named `p2p.attempt_timeout`/`p2p.disconnect_timeout`. This is exactly the reported `p2p.connection_busy` wedge and the 90s UI hang.

3. **Named failures instead of silence and catch-alls (F3 + F7 + F12-partial).** Emit a `reject` signal when an `attempt`/`signal` cannot be matched (glare, unknown attempt, busy) so the loser fails fast with a truthful code; split `p2p.direct_unavailable` into `ice_failed` / `ice_no_udp_pair` / `signal_candidate_rejected`; and make revocation recoverable (`renewRefusal` → `revoke`, and allow a re-authorized network to clear `revokedNetworks`) so a re-join is not a permanent refusal that only a restart clears. This removes the two misleading diagnoses ("their network is unreachable", "this pair is not yours forever") that dominate the instability reports.
