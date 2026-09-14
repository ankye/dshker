# Removing a device now removes its pairs, and one network selects itself

Date: 2026-09-14
Change: `go-owned-headless-core` (P6) — remote-connections surface

## What was wrong

Three user-visible defects, all seen on a real machine:

1. **A device could not be removed at all.** The network device list was
   presentation-only: the operation to unbind an owned device existed in the
   coordinator and in the core (`devices.unbind` → `DELETE /v1/networks/:id/devices/:deviceId`),
   but no shell call and no control reached it.
2. **A removed device kept its pair row.** Unbinding makes the coordinator drop
   bindings, credentials and pairs in one transaction, and the catalog is meant
   to be re-recorded from the coordinator's pair list — but that sync only ran on
   the periodic sweep, and the sweep was colliding on the per-service operation
   lock (`p2p.service_busy`, visible in the app log). The dead pair therefore
   stayed on screen and looked like something the user had to delete by hand.
3. **One network still had to be clicked.** The account panel deliberately never
   auto-selected, because guessing among several networks would aim the next
   edit, limit raise or delete at the wrong one. With exactly one network there
   is nothing to guess, so the click carried no decision.

## What changed

- `P2PDeviceDirectory.vue` gains a two-step removal per non-local row (ask, then
  confirm, then busy while the server answers). It stays presentation-only and
  emits; the panel owns the write.
- `P2PAccountPanel.vue` performs it through `accounts.removeDevice`, which is now
  `leaveNetwork` for a device that is not this machine: `accounts.unbindDevice`
  calls the core's owner-side `devices.unbind`. Leaving (this machine) still goes
  through enrollment, which clears the local credential.
- `management.leaveNetwork` re-records the catalog right after a successful
  unbind, so the dead pair disappears with the device; `#refreshMembers` retries
  once on `p2p.service_busy` so the pruning is not lost to a lock collision.
- `P2PPairingPanel.vue` gains a per-pair revoke with the existing warning shown
  before the write — for "drop this pair, keep the device", which the device
  removal does not cover.
- `P2PAccountsDomain.networks` selects the only network, and still refuses to
  pick among several or to match by display name. The guard tests were
  re-expressed for that rule and a new case pins the several-network behaviour.
- `selection-preferences.ts` (new, not wired yet) is the durable half of
  "remember the network I chose": a strict `dsh-launcher.p2p-selection` v1 record
  below the Settings root, per service and per account, written only for explicit
  choices, atomically, `0600`, refusing symlinks, unknown fields, future versions
  and malformed ids. Exposing it to the renderer changes the frozen preload
  surface, so it is deliberately left for its own change.

## Evidence

- `npm run type-check`, `npm run format:check`, `npm run architecture:check`
  (no findings), and the full vitest suite.
- Live UI probe over CDP against the running app: with one network the row reads
  `mynetwork · 10 台 · 当前网络`, the "select a network" prompt is gone, the radio
  is checked and the device directory has already been read — no click.
