# Why a machine that left a network still reads as online

Date: 2026-09-14
Change: `go-owned-headless-core` (P6) — remote-connections surface

## The question

After removing devices, the network device list no longer showed this machine,
while other surfaces still reported it online. That reads like a half-finished
removal, so it needed an answer rather than a fix to the data.

## The answer, from the coordinator's own contract

`docs/protocol.md` (dshker-server): 解绑只影响指定网络 — and the device record,
its certificate and its account session are untouched. Presence comes from the
heartbeat the device sends with its own credential, not from membership. So:

- membership (`GET /v1/networks/:id/devices`) — no, this machine is not in it;
- presence (heartbeat) — yes, still online;
- and both are correct.

Making it permanent is a different operation: revoking the device
(`internal/coordinator/certificates.go`, `devices SET revoked=1`). The user API
table has no route for it today, so a launcher control for it needs a coordinator
endpoint first, then a core method, the shell call, the frozen surface and the UI.

## What changed here

Presentation only. `P2PDeviceDirectory` now says `本机不在这个网络…` when the list
has rows but none of them is this machine, with the reason (identity and session
survive) and where to re-enroll. The empty-network and listed-local cases show
nothing extra, and a test pins all three.

## Evidence

- Directory suite: 13 cases, including the new absence notice and its two
  negative cases.
- `type-check`, `format:check`, `architecture:check` clean; the locale line budget
  is unchanged because the now-unused removal-failure copy was dropped with it.
