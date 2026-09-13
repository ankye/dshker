# Changelog

## Unreleased

- A reconnecting remote workspace no longer fails the moment it comes back. A
  message that arrived in the instant between the connection opening and its
  identity being checked used to tear the whole connection down, which made roughly
  one reconnect in ten die immediately with “no direct path” and then quietly come
  back on a later attempt. The check now waits for itself, so a re-established
  connection stays up; bytes are still only accepted once the peer's identity is
  verified.

- A remote workspace keeps **the same address** when the connection drops and comes
  back. The gateway that serves a paired computer's DSH Web used to be created per
  connection, so every reconnect moved it to a new port and any browser tab left
  open on the old address went blank. The gateway now belongs to the pair: the
  address survives a drop, a network change, a wake from sleep and even a restart of
  the other computer's DSH, and a tab recovers on its own. Only revoking the pair, or
  deleting its network, retires the address.
- A connection is no longer torn down by a brief interruption. WebRTC reports
  `disconnected` for a few lost packets, a changed network or a machine waking up and
  normally recovers within seconds; treating that as a failure meant every hiccup cost
  a fresh hole punch. A lost path is now given 20 seconds to recover, and a peer that
  stays away is still reported, with its reason, once that window passes.
- Paired computers are now connected **without being asked**: connecting happens at
  startup for every active pair, a dropped connection is retried immediately and then
  with a widening delay, waking the machine retries at once, and only losing
  authorization stops the attempts (the refusal is kept so the reason stays visible).

- Your paired device credential now lives in the **native secret store behind
  the headless core** (macOS Keychain, Windows DPAPI) instead of an
  Electron-encrypted file. An existing credential from a previous version
  migrates itself once on first launch and keeps working; a core that cannot
  start falls back to the previous behavior instead of failing the app.
- Fixed a data-loss defect found during that migration: the macOS Keychain
  writer silently truncated any secret longer than 128 bytes and corrupted
  binary values. Secrets are now encoded and stored in chunks; no released
  version was affected (the previous releases never used this path).

## 0.1.29 — 2026-09-12

- A remote connection that succeeded through the **relay** no longer tears
  itself down: the selected-path check rejected any pair involving a relay
  candidate, so the first data-channel open on a relayed session was reported
  as “no direct path”. A relayed UDP pair is now accepted like any other, and
  ICE still prefers the direct path when one exists.
- Pairing signals no longer expire before they are delivered: offers and
  answers carried the lease's expiry as their own validity, which the
  receiving peer always rejected as expired. Each signal now carries a
  short, signal-scoped validity window.
- The first **two-machine session** is verified: a Mac drove the DSH Web
  runtime on a Windows host through the P2P stack over the live coordination
  server — connection, selected path, local gateway URL, and the remote DSH
  Web page loading through the tunnel.

- P2P connections now fall back to your deployment server as an **opaque relay**
  (TURN, RFC 8656) when no direct UDP path can be established. The server only
  forwards the end-to-end encrypted packet stream (DTLS/SCTP ciphertext) and can
  neither read nor inject the traffic; a network where neither a direct nor a
  relayed path works still reports `direct_unavailable`, honestly. A relay
  credential fetch that stalls (for example while the server restarts) can no
  longer stall other connections: the fetch runs outside the session lock and
  degrades to the direct path on failure.

## 0.1.28 — 2026-09-11

- A computer that is online in a shared network now appears in the Run route's
  “+ / 添加远程工作台” picker, and can be connected to. The Launcher built that
  list from the coordinator's device directory, which deliberately carries no
  device keys, so pairing was never recorded and the list stayed empty while the
  device directory showed the computer online. The list is now built from the
  pairing records, and the identifier sent to the coordinator is the remote
  device's id — the id it authorises a connection by.

- A failed remote connection now reports why. Every attempt used to be reported
  as “remote runtime unavailable”, so a network that cannot establish a direct
  path was indistinguishable from a remote machine that was not serving DSH.
  “No direct path” is now reported as such.

- Starting DSH Web no longer fails blindly when its fixed port is still held by
  a leftover DSH Web process, e.g. one left behind by an earlier crash or by a
  manual development launch. The Launcher detects the holder before spawning,
  stops a residual instance it recognizes as its own, and only refuses with a
  clear “port in use” message when another program holds the port.

## 0.1.27 — 2026-09-11

- Fixed the macOS application icon package so Finder and Applications display
  the complete multi-layer DSHKer icon instead of a broken or blurry fallback.

- Updating a managed plugin now converges its Launcher-owned clone to the
  fetched revision before checkout. Build residue can no longer brick an
  extension update or surface as a misleading core-launch failure.

- Fixed a blank Run page after the P2P security hardening. Electron 42 reports
  an omitted WebView session partition as an empty string; the strict policy
  now admits only that exact platform representation while continuing to reject
  arbitrary partition labels.

- Remote workspaces are created on demand. Run starts with Local only; click
  “+” and choose a computer from the LAN or SSH list to create and focus its
  non-closable tab. The picker is a bounded floating panel that lists ready
  workspaces first and keeps unavailable ones visible but disabled with their
  real status.
