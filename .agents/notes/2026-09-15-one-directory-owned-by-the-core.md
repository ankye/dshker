# One directory, owned by the core

Date: 2026-09-15

## What was reported

Two machines in one network disagreed about who was in it: one listed only the
other computer, the other only itself, and its own row read "offline" or "never
reported". Refreshing did nothing; only quitting and restarting the app produced
the current list. The Run tab's "add remote workbench" menu showed no LAN computer
at all, and a paired computer the server had already authorized could not be opened
from it.

## Why the first fix was not enough

The first attempt added a refresh control, a re-read when the page opened, and a
thirty-second tick in the panel. That addressed the symptom and not the cause: it
left the directory with several owners — the coordinator, the core, main, the
renderer's per-network map, and a cache inside each page — and gave every copy its
own way of catching up. A list with four owners is a list that can be wrong in four
ways, and "refresh does nothing" was only the most visible one.

## The rule that was being broken

`openspec/changes/go-owned-headless-core` already states it: _a single native core
process SHALL own the coordinator session, P2P transport, pairing, catalog
persistence, the reverse proxy, the SSH tunnel and its descriptor exchange, the DSH
child process, and the secret storage those depend on._ Its design adds the
corollary this change restores: _each persisted store has exactly one writer
during any phase._ The persisted catalog had already moved into the core. The
coordinator's **network directory** had not: it was read by whoever rendered it and
kept for whatever lifetime that page had.

## What the core does now

`networking/internal/helper/directory.go` holds one snapshot per service: the
account's own bound devices and every network it owns with its members.

- **It learns the session from calls it already serves.** Every user and network
  operation carries the token the shell is using, so the core records it and
  refreshes on the first such call — which is the persisted-session adoption the
  shell performs at startup (`user.current`), so a restarted app has a current
  directory without a separate handshake and without any page being opened.
- **It reads when the answer can have changed**: `devices.bind`,
  `devices.unbind`, `network.leave`, `network.join`, `networks.create`,
  `networks.delete`, `pairs.adopt`, and every `DirectoryMaintenanceInterval`
  (30s — the coordinator records last-seen at most once a minute, so a faster
  cadence would only ask the same question more often) while a session is known.
- **It announces only real changes.** The revision moves when the content does and
  the core sends the parent-role `directory.changed` callback; a read that found
  the same devices sends nothing, so a list that did not change is not re-rendered.
- **It keeps the last good snapshot when a read fails**, and sign-out drops the
  session and the snapshot together, because one account's devices must never be
  shown under another's session.

`directory.inspect` answers the held snapshot and never touches the network;
`directory.refresh` reads the coordinator first. The shell forwards
`directory.changed` to the window, and the account domain projects it — one
projection, no page-level cache.

## What this removes

- The panel's thirty-second re-read and its read-on-open of a per-network op: the
  list arrives by announcement, and opening a page reads the core's snapshot.
- The refresh control survives, and now means what a user expects: ask the core to
  read the server again _now_.
- `networkDevices` / `accounts.listDevices` in the shell no longer call the
  coordinator; they project the core's directory, so there is exactly one place
  that reads it.

## What the first release of this got wrong

0.1.42 shipped the ownership change and two mistakes that produced a visible
regression: the account page reported "the device list could not be read" over a
list it had already fetched.

1. **Main's duplicate-submission guard is keyed by service, and reads took it.**
   The renderer queues reads per operation scope, so its two directory reads
   (`directory` and the per-network `networkDevices`) were different to the
   renderer and the same to main: the second was refused as `p2p.service_busy`.
   Reads no longer take that guard; writes still do.
2. **The document could exceed the private channel's concurrency.** The channel
   admits sixteen concurrent calls and refuses the rest with `p2p.helper_busy` —
   the contract `internal/localrpc/rpc_test.go` and `stress_test.go` pin. Several
   panels mount at once and each reads on entry, on top of the shell's own startup
   reads, so the burst overflowed and the refusal landed on whichever feature lost
   the race. `P2PManagementDomain` now admits at most `MAX_CONCURRENT_CALLS` (6) at
   a time and queues the rest, and the account domain treats a busy answer
   (`p2p.service_busy` or `p2p.helper_busy`) as "another read is already in flight",
   not as a failed read.

The presentation rule that follows from it: **a failure never hides data.** A failed
read replaces the list only when there is nothing to show; when rows are already
there, the failure is a note beside them. Hiding rows the user can see is what made
a healthy list look empty.

## Verified end to end

Against the live deployment, on the Windows machine whose list was reported
frozen: the core's snapshot held both members of the network (`USER-20260612LO`
and `1021500932s-MacBook-Pro.local`, both online, both reporting 0.1.41), and over
100 seconds the renderer received three `directory.changed` announcements — one per
maintenance read whose content had moved — with the revision advancing 3 → 6.
Opening the account pane showed both rows (`2 台设备 · 上限 10`), the local row
reading "just now", with no refresh click and no error. Note for the next probe
against a running document: **never inject a request id**, because the replay guard
poisons that document's own sequence (`p2p.request_replayed`) for every later call
the page makes.

## Open follow-up (deliberate)

The shell still exposes two renderer-facing ops that project the same snapshot: the
`directory` / `refreshDirectory` contract this change adds, and the older
per-network `networkDevices` / `accountDevices`. Both now read the core, so there is
one source, but `accountDevices` had to keep a forced read (`directory.refresh`)
because its result type has no way to say "not read yet" and the Connect page reads
an empty list as "this machine belongs to another account". Once
`p2pEnrollment.readAccountDevices` is migrated to the directory contract and honours
`known: false`, the legacy ops can go back to the cached snapshot or be retired.

## What this still does not do

Presence is not instant: the coordinator answers it from its live session table and
persists last-seen at most once a minute, so a row can lag by that much. The
catalog of _paired_ computers is a separate list and is still synced on the shell
side (a `pairs` read), because a network membership and a pairing authorization are
not the same thing; a push there would need its own announcement and is not part of
this change.
