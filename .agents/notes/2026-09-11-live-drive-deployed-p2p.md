# Live drive: deployed co-membership server, pair alignment, lease window and fabric constraint (2026-09-11)

Live end-to-end drive of the networking core against the real deployed server
(https://my.ffkey.com:8443) from macOS 10.147.17.251 to Windows 10.147.17.110, using
`networking/tools/live-drive` (build-tagged `live`).

## What was proven live

- Registration/enrollment/adoption all work against the deployed server: A (mac) registers,
  B (win) enrolls, B adopt derives a co-membership pair, A enumerates adopt+pairs and pins the
  active record. The deployed server has **no share/invite path**; pairing is adopt-derived and
  already-existing pairs are only visible through the pairs list.
- The incoming attempt reaches the target through the signaling WSS and carries the correct
  signed lease (target device ID in `pairId`, revision 1).
- The Windows full integration suite (including both real-DSH tests with the rebuilt harness)
  is green with the current source (`RUN6=0`, integration 191.478s). The macOS full `-race`
  suite is green (integration 227.151s pass).

## Product fixes landed

- `internal/protocol/lease.go`: the 60s upper bound on lease validity rejected leases the
  deployed server grants with ~62-65s TTL; the target side failed the attempt with
  `p2p.lease_expired` while the initiator (checking 1-2s earlier) passed. Upper bound relaxed
  to 2 minutes (still rejects far-future/forged expiry).
- `internal/peersession/manager.go`: incoming-attempt `start` errors were dropped silently;
  now printed to stderr. This is what surfaced the lease rejection.

## Fabric constraint (environment, not code)

- Raw UDP between the two hosts over the office ZeroTier virtual network is dropped in both
  directions (ICMP/TCP traverse fine; Windows firewall allow rules for these hosts/ports do
  not change it). The ICE direct path therefore fails honestly with `p2p.direct_unavailable`.
- The backup drive leg (SSH local forward, TCP) reaches the Windows DSH web end to end:
  `curl 127.0.0.1:9777/` → 401 auth gate, `/?token=...` → 303. The Windows DSH web ran from
  the checkout build (the launcher-managed `versions` dir was temporarily moved aside to let
  the CLI boot from its own tree; restored afterwards).

## Process notes

- pnpm store/JUNCTION hell on the Windows harness copy: a full `node_modules` nuke+reinstall
  plus removing nested `node_modules` was required; the harness web build then succeeded.
- Windows `-race` needs a C toolchain: no gcc on the box; winlibs gcc (MSVCRT) staged; the
  race leg will complete once gcc is on PATH.
