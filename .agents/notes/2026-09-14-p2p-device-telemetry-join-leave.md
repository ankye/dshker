# Device telemetry, login-free join, session-backed leave

## What changed

The last two management stubs are gone. Every operation in
`P2PManagementOperation` now reaches a real implementation, so
`PeerManagementOwner` no longer excludes anything but `cancel`.

## join and leave are deliberately asymmetric

`joinNetwork` is login-free: possession of a networkId is the entire claim, and
the coordinator's `POST /v1/network/join` sits outside its authorized route
groups. It had been exposed all along; the earlier probe that concluded otherwise
only tested `/v1/networks/:networkId/devices`.

Unlike `register`, a join does not know its owning user beforehand — the
coordinator makes the network's owner the device's owner — so the identity is read
from the confirmed result rather than asserted up front. Every other submitted
field is still checked against the reply, and the credential is committed only
after an independent readback.

`leaveNetwork` requires the owner's session and reuses
`DELETE /v1/networks/:networkId/devices/:deviceId`. There is no login-free
removal, and that is not an oversight to be fixed later: without a cryptographic
proof of device ownership, any holder of a deviceId could evict someone else's
machine. The renderer disables the action until a session exists and states the
reason next to it.

Local credentials are cleared only after the server confirms. A refused removal
keeps the credential rather than stranding the device.

## Telemetry

Devices report `version`, `platform` and `architecture` on each heartbeat.
Every field is self-declared and descriptive: it is displayed in the device
directory and is never used for authorization.

- The launcher's version comes from `APP_METADATA.version` (the same source the
  updater compares against), passed on every `service.configure`. The helper is
  told rather than guessing.
- `WithDevice` copies telemetry into the device client. Without that, heartbeats
  would silently report nothing, because they run on that client rather than the
  base one.
- Empty means unchanged server side, so an older client sending `{}` keeps
  working and does not blank what it previously reported.
- Values that cannot be rendered safely (over 64 bytes, untrimmed, control
  characters) are dropped rather than refused. The heartbeat's real job is
  liveness; a cosmetic field must not take a device offline.

Physical IP was considered and left out: it would persist every device's public
address, which is precisely what this product's users are likely to object to.

## Server schema 5 (breaking)

`devices` gained `last_seen`, `version`, `platform` and `architecture`. The
version is now the `SchemaVersion` constant instead of a literal repeated in
three places. There is no migration path: the store refuses any other version, so
an existing database must be rebuilt. The deployed coordinator was rebuilt, which
changed its `serviceId`.

Last-seen is persisted at most once a minute. Presence itself stays in memory and
stays exact; only durability is throttled, because heartbeats arrive far more
often than a human opens a device list. Going offline clears the throttle so the
next heartbeat is durable immediately.

## Device directory

Device lists project `DeviceEntry`, not `Device`: presence, last seen and the
reported build, and no certificate. The previous projection handed credential
material to a view that only needs to identify devices.

`isLocal` is derived from the registered credential, never trusted from the
reply, so the UI can refuse to remove the machine the user is sitting at. The
owner returns it alongside the directory in one call — combining two owner
operations inside the IPC layer made one read look like two, which the routing
test caught.

`P2PDeviceDirectory.vue` is presentation only and never fetches on its own; the
panel owning the read owns the timing. The directory follows the selected network
rather than expanding every row, so an unselected network is never fetched.

Distinctions the UI preserves:

- Not-yet-read (`undefined`) and empty (`[]`) are different facts. Only a
  completed read may say a network has no devices.
- `lastSeen === 0` means never reported, not reported long ago.
- Relative times round down to the coarsest useful unit, since the server
  persists at minute granularity. One shared ticking clock keeps rows in
  agreement.
- An unreported build reads as unknown rather than being hidden.

## Fixed along the way

The main process accepted only `online` and `offline`, but the coordinator also
reports `stale` for a heartbeat past its liveness window — from the same call
that backs pair identity. A device a few seconds late made the whole read fail
with `p2p.protocol_mismatch`. Stale is now accepted and narrowed to `offline`,
which the existing contract already said should happen.

In `P2PJoinPanel.vue`, the identity block's two-column rule never applied: the
selector was `.p2p-device-info dl > div`, but that element is itself the `dl`.

## Constraints worth remembering

- The translator is `(key) => string`. There is no interpolation anywhere in the
  project, so values are composed in templates and new keys carry no
  placeholders.
- Component tests assert against the dictionary rather than string literals; the
  test locale defaults to `zh-CN`.
- Server builds need `GOWORK=off`.
