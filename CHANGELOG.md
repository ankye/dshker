# Changelog

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
