## Why

For users keeping a remote DSH workbench open overnight, a recovered P2P link can
report connected while its original browser gateway remains detached and returns
HTTP 502. Restore the explicitly requested workbench, not just device transport,
without requiring a restart, login, or another click.

## What Changes

- Retain the workbench intent of an explicitly opened remote computer across a
  transient transport loss within the running core's lifetime.
- Re-establish its authenticated runtime binding and original local gateway;
  transport-only devices remain transport-only and never activate DSH.
- Keep generation, pair, service, cancellation, revocation, and replacement
  ownership strict. Explicit disconnect and authorization removal clear intent.
- Test real HTTP/WebSocket recovery, repeated loss, simultaneous directions,
  rejection, and terminal cleanup, in addition to focused state-machine tests.
- Allow explicitly opened SSH/P2P browser tabs to close and reopen from the add
  menu. Keep Local permanent; closing a guest is not a remote runtime stop or
  connection-record deletion. Disconnected SSH records may reconnect from that menu.
- Preserve credential-free first-termination diagnostics for each attempt,
  including ICE/channel state, receive/lease timing and the trigger that won.
  Fix the confirmed grace-expiry/recovery race without changing its deadline.
- Exercise eight hours of real bidirectional application idle on the authorized
  physical Mac and Windows hosts, preserving the original sessions/connections;
  manual page reopening cannot satisfy the long-duration acceptance.
- Separately inject short, long and repeated UDP outages into the uniquely owned
  temporary Windows core, with an independently verified local cleanup task.
  Verify both directions through production automatic-reconnect policy, without
  a manual connect, page reopen or DSH restart. An interrupted idle run remains
  incomplete and cannot become a weak-network pass.
- Verify an explicitly requested isolated peer-process crash and restart without
  changing system firewall policy. The surviving client's original workbench
  intent, gateway and application identity must be distinguished from the killed
  core's lost in-memory intent and gateway. Process-crash evidence is not UDP
  outage or overnight-idle acceptance.
- Move DSH process supervision into a private, independent runtime owner. Both
  core entry points reconnect to that authenticated owner after a core crash,
  retaining the real child, output pipes, binding generation and console cursor.
  Resume never creates a child or adopts a PID/URL from a cached record.
- Following the user's latest instruction, publish the repaired stable Release
  through GitHub CI so the user can install and validate it. Report source/CI,
  physical long-duration and installed-app acceptance as separate evidence
  tiers; do not claim uncompleted physical or native UI gates as passed.
- Jointly add control-v2 candidate handoff to the independent Gin/SQLite server
  and client. Keep a suspended primary while preparing one replacement; probe
  that replacement before committing it, and read back durable decisions after
  lost responses. Existing account, network, device and pair identities survive.
- Use current authenticated peer registrations and event-driven recovery rather
  than waiting for the periodic sweep after grace expiry. Keep ICE/grace and
  physical recovery deadlines unchanged. Never claim cached ready as live ready.
- Automatically repair a locally revoked saved connection when fresh server
  authority confirms the same account, original network and both original
  device identities and keys. Preserve explicit selection for a different scope
  and fail closed on real revocation or an unavailable authoritative read.

## Capabilities

The joint implementation also requires an explicit current-account v2 pair
identity read and read-only-registration/fresh-pin/candidate-capability bootstrap.
This repairs the reviewed enrollment-owner versus selected-account mismatch
without rewriting saved device identity or borrowing legacy authorization.

### New Capabilities

- `remote-workbench-recovery`: Preserve explicit workbench intent and restore
  its gateway after transient P2P disconnects.

### Modified Capabilities

None.

## Impact

The Launcher Go control-plane/peer/session/reconnection owners, typed desktop
state, tests, verification tooling and documentation; and the independent
`dshker-server` repository's authenticated control API and additive schema 7.
The server planning owner is go_workspace OpenSpec change
`preserve-dshker-active-connection-on-recovery`. No NetHopper dependency, DSH API,
renderer credential access, automatic enrollment or replacement network is added.
The user approved local joint integration followed by production server
replacement preserving port 8443, then physical bidirectional long tests and
stable publication only after the gates pass. Preserve original installed
client/DSH processes and credentials; build isolated candidates for validation.
