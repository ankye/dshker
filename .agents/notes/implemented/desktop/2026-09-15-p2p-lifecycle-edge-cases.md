# P2P pairing and connection: a systematic edge-case pass

Date: 2026-09-15
Status: implemented (0.1.38)

## Why this exists

A live outage — one machine could see the other but not the reverse, and the
reverse could not open the other's workbench — was worked for hours and produced
four separate fixes before anyone could say how many more of the same kind were
waiting. That is a symptom of missing coverage, not of an unlucky bug, so the
subsystem was audited as a whole instead of one failure at a time.

Method: four read-only audits over the pairing and connection lifecycle —
Go core session lifecycle, Electron shell pairing/identity/catalog, the runtime
(desktop) stage after the transport is up, and failure diagnosability. Each
enumerated edge cases, gave file:line evidence, the user-visible symptom, and a
minimal fix with a test idea. The reports are kept as the backlog:

- `docs/audits/p2p-shell-edge-case-audit.md` (20 findings)
- `networking/docs/p2p-robustness-audit.md` (16 findings)
- `docs/audits/p2p-runtime-stage-audit.md` (9 findings)
- `docs/audits/p2p-diagnosability-audit.md` (observability design)

## The lifecycle states that must converge

Pairing looks like a two-peer handshake but has six independent state machines
that have to agree: the coordinator's pair record, each device's local catalog,
each helper's pin map, the live session, the runtime binding behind it, and the
signed lease that authorizes the bytes. Every wedge found tonight was one of
these six disagreeing with another and no path back:

| Transition                                           | Converges?   | Where                                                                                                   |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Both devices re-enroll (new identities)              | fixed 0.1.38 | local catalog row now recorded revoked, not dropped                                                     |
| Coordinator connection drops                         | fixed 0.1.38 | subscription supervised and re-established in-process                                                   |
| Peer re-paired / network rejoined after a revocation | fixed 0.1.38 | revoked record retired in its own commit first                                                          |
| A pair naming neither side of this device            | fixed 0.1.38 | skipped in the list projection and the identity read                                                    |
| Removed by another device (while running)            | partially    | retry stops with the real code; the pin is dropped by the core, not projected to the shell              |
| Removed by another device (while closed)             | partially    | converges as an omission on the next sync                                                               |
| Leave a network and re-join it                       | **open**     | no local revocation is recorded (safe), but the pending enrollment is stranded with no reachable submit |
| Switch account                                       | **open**     | nothing durable is cleared: account B inherits account A's device, pins and rows                        |
| Both peers try to connect at once (glare)            | **open**     | neither tolerated nor refused; the loser is reported as a network failure                               |

## Fixed in this pass

Go core (`networking/internal/peersession`, `internal/controlplane`):

- A supervised coordinator subscription (`signaling.go`) that replaces a lost
  connection in-process with capped backoff, marks signalling down while it is
  gone, and refuses `Connect` at once with `p2p.server_unavailable` instead of
  letting the attempt run out its deadline and report a transport failure. Test:
  `signaling_test.go` — a lost subscription is replaced after a failed dial, the
  replacement receives the events and the sends, and a closed supervisor stops
  dialling.
- An unknown event type from the coordinator no longer tears the subscription
  down (`signals.go`); it is skipped.
- `finish` is idempotent (`sync.Once`): both the connecting caller and the session
  runner reach it, and a second `close` of `done` panics the core, which would
  take every pair down until the application restarted.
- `revoke` records the network in `revokedPairs`, so a session still being
  reserved is closed with the revocation instead of outliving its authorization.
- The runtime handshake stops destroying the reason: the responder sends the
  refusal the runtime owner named, and the initiator returns a code the protocol
  admits instead of the single `p2p.runtime_unavailable` (whose own comment
  already claimed not to swallow it).

Electron shell (`electron/main/p2p`):

- `peerPairs` skips a listed pair that names neither side of this device, and
  `PeerPairing.members` skips one whose identity reply does the same. Rejecting
  the whole read for one leftover aborted the sync before it could write pins or
  the catalog — the machine went on seeing only itself and answered no offers.
  Tests: `pairing.test.ts` (both layers).
- `recordMembers` retires a revoked record in its own commit before recording a
  new authorization for the same connection, because the catalog refuses to take
  a revoked computer back to active at all. The strict guard is unchanged and a
  test now pins the two-step requirement.
- `TERMINAL_CODES` names the two authorization refusals the core really sends
  (`p2p.pair_unauthorized`, `p2p.network_revoked`), so a removed computer stops
  being re-attempted in silence. Test: `auto-connect.test.ts`.
- `PeerRuntimeOwner.connect` re-reads the runtime state instead of answering from
  cache, so a workbench that died unobserved is not handed to a peer as running.
  Test: `runtime-owner.test.ts`.
- The management error admission now carries the `runtime.*` family and the
  missing `p2p.runtime_*` codes. Every one of them used to reach the renderer as
  a bare `p2p.internal_error`, which is why "the tunnel is up but the desktop is
  not" had no readable cause.

Release pipeline:

- The packaged smoke settles its probes on microtasks and forces its own layout
  instead of waiting on renderer timers and frames, and every renderer round trip
  is bounded. A locked or disconnected desktop stops delivering both, which
  stalled the smoke for 55s until the runner killed it with no reason recorded;
  it now completes in ~1.8s at that step and reports where it hung.

## Open, in priority order

1. **The peer workbench URL never reaches the renderer** (runtime audit R-01).
   `runtimeBrowserState` reads a peer tab's address from a map nothing writes, and
   the only writer is driven by a webview that mounts only once the address
   exists — so even at stage `ready` the tab shows the empty state and the Remote
   tab's "Open workbench" leads there. Main already holds the URL; no operation
   exposes it. This is the unchecked OpenSpec task 4.3 and it is the difference
   between "connected" and "the desktop opened".
2. **Failure text** (R-03). The refusal code reaches `RuntimeTabStatus.failed.code`
   and is rendered nowhere, so a transport failure and a runtime failure look
   identical; the peer empty state reuses SSH copy. Needs copy through the locale
   dictionaries and the code on screen.
3. **A bounded attempt** (Go audit F4/F5/F8/F14). An attempt has no hard deadline
   of its own, the shell's cancellation only rejects its promise while the core
   keeps working to its 90s handler cap, and `run`'s 30s readiness wait equals
   ICE's own 30s failure budget — a coin flip that also decides which refusal the
   user sees.
4. **Glare** (F3) and **account switching** (shell audit finding 7).
5. **A P2P event journal** (diagnosability audit). The app holds every fact needed
   to explain a failure, keeps it for one attempt, and discards it; a bounded,
   redacted rotating file in the settings root would turn the next outage into one
   file read instead of an afternoon of instrumentation.
