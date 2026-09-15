# Changelog

## 0.1.42 — 2026-09-15

- **The device list now has one owner, and it keeps itself current.** A network's
  device directory is read and held by the core instead of by whichever page
  happened to open it. Each page used to read the server for itself and keep its
  own copy, so two computers in one network could show two different member lists
  and neither ever caught up — one listed only the other computer, the other only
  itself, its own row still reading "never reported", and only quitting and
  restarting the app produced the current list. Now, if this computer is already
  signed in when the app starts, its networks and their devices are **there on
  first launch** — no tab to open and nothing to refresh. The core reads the
  directory when the session is restored, after anything that changes who belongs
  to a network (registering, binding, leaving, creating or deleting a network,
  pairing), and every thirty seconds while a sign-in is active; when the content
  changes it tells the window, and every list on screen updates by itself. The new
  **Refresh list** control asks for a read right now if you would rather not wait.
- The Run tab finds paired computers by itself. The add-workbench menu reads the
  paired computers main keeps in its catalog, and only a P2P page had ever asked
  for them, so opening the Run tab first — or after a restart — showed "choose a
  LAN or SSH computer" with an empty LAN section even though the server held an
  active pair. The menu now asks for the pairs when it mounts and again every
  time it opens, so a computer paired after the app started appears without
  visiting another tab first.
- A device list read no longer loses the race with the page's other reads, and a
  directory that could not be read keeps the last rows instead of silently
  showing an empty network.

## 0.1.41 — 2026-09-15

- A first install reaches the official server. The handshake asks the coordinator
  a challenge and the shell accepts only the thirty-two character challenge shape,
  but the core had been minting that value from the id generator — which the
  twelve-character id change shortened to twelve. The shell then refused its own
  core's answer, so a new machine showed an empty server list, could not sign in,
  and was told nothing about why. The core now mints a real challenge, and the
  coordinator accepts both shapes, so a machine that has not updated yet still
  reaches it.
- A stored configuration this build cannot read is repairable from the page that
  reports it. A machine that upgraded from a release using the older identity
  scheme (ids of another length) kept a record every operation re-validates —
  including the removal of a single service — so the Connect card could neither
  read it, use it, nor drop it: it showed `p2p.catalog_invalid` beside a retry
  that could never succeed, the account page then had no server to sign in to,
  and the only way out was deleting files by hand. The card now says the record
  comes from an older release, offers to discard it, keeps both files beside the
  new one as `p2p-devices.json.legacy-<stamp>`, leaves the device key and the
  saved sign-ins alone, and provisions the built-in server again.
- The card no longer loses the failure it is reporting. The status line and the
  connections panel mount beside it, and their reads carry no service, so they
  landed in the catalog's own operation slot and overwrote a failed read with
  their success: the card then claimed nothing had been read, with no code at all.

## 0.1.40 — 2026-09-15

- A connected computer's workbench now opens. A paired computer that had
  connected successfully showed a green state and an empty page with a "connect
  first" message, because the address main held was never handed to the page that
  mounts it: the tab was waiting for a value that nothing supplied. The address is
  now asked for per connection attempt, and a tab whose attempt has been replaced
  is never handed the previous one.
- A failed connection says which side is wrong, and keeps the error code on
  screen. Every failure used to read the same, with copy that told you to retry
  the other computer's SSH tunnel — there is no tunnel between paired computers.
  The tab now distinguishes this computer not being set up, an unreachable
  coordination server, the other computer being offline, a network that cannot be
  reached, a workbench that did not start, and an authorization that is gone.
- The device id on the Connect card is this machine's real device id — the one the
  coordinator registers, the member list shows and every paired computer pins. The
  card used to show a locally generated number that identified nothing anywhere
  else, so copying it into a member list did not work. It is the same value the
  server reports for this machine, and it is available before any account is
  bound.
- A computer bound to more than one account reports its presence to the account
  signed in on it. The device identity kept naming the account the machine first
  enrolled under, so a machine that had since been added to a second account
  looked offline there while it was running, and "this computer's identity belongs
  to another account" was reported for a machine that belonged to both. The
  warning now appears only when the signed-in account's own device list — read
  from the coordinator — does not contain this machine.
- A device directory that includes a computer another account enrolled first no
  longer fails to read. The row's owning account was compared with the reader's,
  and a machine bound to two accounts carries the first one's name, so the whole
  member list was refused as a scope mismatch.

## 0.1.39 — 2026-09-15

- Identifiers are twelve characters, the length and alphabet of a hardware
  address, so a device id can be read out, typed and compared by a person. A
  device id is derived from the machine's key, which means one machine is one
  device for the life of the machine — across accounts, networks and
  re-enrollments — and the coordinator records which accounts a machine reports
  to instead of a single owner.
- The device id is shown next to the device name on the Connect card, in the
  open, with a copy button, and the network id and enrollment identifiers carry
  the same copy control instead of being selected by hand. The pairing
  fingerprint is the same twelve-character key id.
- This machine keeps one device identity. The device key was minted per
  enrollment, so every registration, every join and every re-enrollment became a
  different device: pairs, pins and catalog rows still referenced the identity
  that had just been replaced, the coordinator's list carried entries naming
  neither side of either machine, and both ends could wedge on the other's stale
  identity — the wedge the same release's other P2P fixes exist to unwind. The key
  now lives in the core's own store beside the data root, like a hardware
  address: one identity per machine, reused for every network and every account,
  and it survives losing the credential record, which is the usual way a machine
  silently became a new device.

## 0.1.38 — 2026-09-15

- A paired computer that re-enrolled no longer disappears from the other machine.
  When both devices re-enroll (each getting a new device identity), the local
  catalog still held the old pair as active, and every member sync tried to drop
  it — which the catalog's transition guard correctly refuses, wedging the sync
  on `p2p.revocation_required` forever: one machine could see the other, but not
  the reverse, and the tab never opened. A row the coordinator's list no longer
  carries is now recorded as revoked instead of dropped, so the catalog converges
  on the next sync while the loss stays visible on screen.
- Pairing survives the coordinator connection dropping. The core subscribed to the
  coordinator once, and a lost connection — a network change, a laptop sleeping, a
  coordinator restart, a half-open socket — ended the subscription for good:
  attempts and signals stopped arriving, nothing reconnected, and only restarting
  the application brought P2P back, while the shell went on showing a healthy
  device. The subscription is now supervised and re-established in-process with
  capped backoff, and a connect attempt made while it is down fails at once with
  `p2p.server_unavailable` instead of waiting out its deadline and blaming the
  transport.
- A pairing relationship whose authorization the coordinator issues again can be
  recorded again. A revoked computer is never revived by the catalog's guard, so
  re-pairing the same two devices — the repair path after a removal — could not be
  written at all and the computer stayed revoked. The revoked record is now
  retired in its own commit before the new authorization is recorded.
- A pair that names neither side of this machine no longer aborts the entire
  member sync. That leftover from a re-enrollment is skipped, so the read that
  writes pins and the catalog still runs; rejecting the whole reply for one stale
  entry is what left a machine permanently seeing only itself and answering no
  offers.
- Being removed by another device now stops the reconnect attempts. The two
  authorization refusals the core actually sends (`p2p.pair_unauthorized`,
  `p2p.network_revoked`) were missing from the terminal list, so a removed
  computer stayed listed as active and was re-attempted forever in silence.
- A runtime refusal keeps its reason. The peer handshake answered every workbench
  failure with one constant, and the management boundary then mapped every
  `runtime.*` code to `p2p.internal_error`, so "the tunnel is up but the desktop
  is not" had no readable cause anywhere. The refusal the runtime owner named now
  survives both hops.
- A workbench that died without the shell noticing is no longer reported as
  available: the owner re-reads the runtime state instead of answering from cache,
  so the peer is never handed an address that is already gone.
- The packaged smoke can no longer hang on a machine whose session is locked or
  whose desktop is disconnected. Its probes settled on renderer timers and frames,
  which such a session stops delivering, so the smoke stalled until the runner
  killed it; they now settle on microtasks and force their own layout, and every
  renderer round trip is bounded so a stall is reported where it happened.

## 0.1.37 — 2026-09-14

- A typed refusal from the core no longer kills the private channel. The frame
  decoder only admitted `p2p.*` error codes, so a refusal such as
  `runtime.port_in_use` failed decoding, closed the channel, and reached the user
  as a bare `p2p.protocol_mismatch` — taking every other core operation down with
  it until restart. The decoder now admits every family the core declares
  (`p2p.`, `managed.`, `launcher.`, `runtime.`, `remote.`), so the real reason
  surfaces and the channel survives the failure.

## 0.1.36 — 2026-09-14

- A failed sign-in, join or start now leaves the real error behind. Anything that was
  not a typed refusal collapsed into `p2p.internal_error` and the original exception was
  dropped, so a join that reached the coordinator and failed locally could not be
  diagnosed from the product. The reason is now written to `shell-diagnostics.log`
  beside the shell's own records, next to the core channel's own diagnostics.

## 0.1.35 — 2026-09-14

- The launcher now records why its private channel to the local core failed, in
  `core-diagnostics.log` next to the core's own state: the exact bytes the core sent
  for its handshake, whether the named pipe or Unix socket authenticated, what
  `core.version` answered, and the child's exit code. This is the difference between a
  core that never started and one that started and disagreed, which a bare
  `p2p.protocol_mismatch` cannot tell apart.

## 0.1.33 — 2026-09-14

- The private channel to the local core no longer closes when the core writes to
  stdout. Only the one-line handshake travels on that stream, so any other output was
  read as a protocol violation and the whole channel was dropped with
  `p2p.protocol_mismatch` — on Windows that surfaced as no device identity, no account
  state, and no way to sign in or out. Core output is now relayed only when
  `DSH_P2P_TRACE=1` is set.
- A failed core handshake now logs what the core actually answered, instead of failing
  silently, so a core that cannot start is distinguishable from one that answered
  wrongly.
- Diagnostics for the local core channel, on every platform: start the app with
  `DSH_P2P_TRACE=1` and the core's own stdout and stderr are relayed, together with the
  reason its handshake was refused. This is what identifies a core that failed to start
  instead of one that started and disagreed.

## 0.1.32 — 2026-09-14

- Devices in a network can be **removed** from the device list, and their pairs go
  with them: unbinding a device already invalidated its pairs on the server, but
  the launcher kept showing the dead pair until it happened to sync, so removing
  one device looked like it needed a second manual cleanup. The list is now
  re-recorded as soon as the removal succeeds, and the sync that does it no longer
  loses to a busy operation lock.
- A single pair can be **revoked** on its own, for when only that pairing should
  end and the device itself should stay. The warning is shown before the write,
  because revoking drops the session immediately and re-pairing never restores it.
- The device list no longer keeps rows the coordinator will **not authorize**: a
  refused member sync used to be logged and skipped, which left dead computers on
  screen (and filled the log) until something else happened to rewrite the list.
  It is now treated as the answer it is, and a transient busy lock is retried.
- A stale catalog row that named this machine as **its own peer** (an artifact of an
  older build) is dropped whenever the network catalog is rewritten, so such a row
  clears itself instead of lingering as a second, impossible "device".
- When this machine is **no longer a member** of the network you are looking at,
  the device list says so instead of leaving an unexplained gap. Removing a device
  only removes it from that network: its identity and session remain, which is why
  it can still read as online elsewhere. Revoking a device outright is a separate
  action and is not offered yet.
- The network you last chose is **remembered** (per account, on this machine
  only), so returning to the screen lands where you left instead of asking again.
  The memory never decides for you: it is used only while that network still
  exists and belongs to the same account, and only a choice you made is stored.
- A network is **selected for you when it is the only one**. The previous rule
  never selected anything, to avoid aiming an edit at the wrong network; with a
  single network there is nothing to guess, so the click is gone. Several networks
  still wait for an explicit choice and are never matched by display name.

## 0.1.31 — 2026-09-14

- The Launcher now runs **one background process** instead of two. The headless
  core that already holds your device credential and your device catalog also
  serves the whole peer protocol, so the separate peer helper is no longer
  started. Pairing, connecting and the remote workspace behave exactly as
  before; what changes is that a machine whose core cannot start reports P2P as
  unavailable rather than quietly running a second process that no longer
  exists. The preflight check now verifies the core binary the app actually uses.
- The same core now also runs **with no desktop session at all**: `dshkerd
serve` publishes its own private endpoint and answers the whole method table,
  `dshkerd dsh start|stop` runs the DSH Web child, `dshkerd status`, `pair`,
  `connect`, `proxy` and `service configure` are named commands over the same
  operations the app performs, and `call` reaches any published method with its
  refusal code printed verbatim. The app is unaffected: it still starts the core
  as its child. `npm run release:readiness` now builds the core and proves it
  answers as a headless host, and the installer workflow runs the same check on
  every platform it packages.
- The core also owns the Launcher's **own root registry** now, so there is one
  writer for the file that says where your Harness, plugins, presets and settings
  live. The file keeps its format and location, an existing install is read
  exactly as before, and a machine whose core cannot start reports its
  configuration as unavailable instead of writing it a second way.

- Your managed Harness installations are the **core's** now too. Registering a
  toolchain, cloning a Harness, switching its revision and starting it ask the core
  for one operation and keep only what it answers with, so a machine whose core
  cannot start reports these operations as unavailable instead of quietly running
  Git itself. The rules that protect a checkout — the pinned Git, the mirror, the
  worktree, and the refusal to follow a branch that moved or a tag that changed —
  live in one place instead of two, and behave exactly as before.
- Fixed a defect that stopped every **headless host** from hosting anything:
  `dshkerd dsh start` told the DSH child to read an overlay file it never created,
  so the child exited immediately (`runtime.child_crashed`) and the host had no
  address to give. The command that names the file now creates it — an empty
  overlay, the same one the desktop app writes for its own profile — while a
  patch you name yourself is left exactly as it is.

## 0.1.30 — 2026-09-14

- Paired computers are now connected **without being asked**, and stay that way.
  Connecting happens at startup for every active pair, a dropped connection is
  retried on its own (immediately at first, then with a widening delay), and waking
  the machine or regaining a network retries at once. Only losing authorization
  stops the attempts, and the refusal is kept so the reason stays visible. Switching
  between tabs never interrupts a connection: it belongs to the pair, not the view.
- A remote workspace keeps **the same address** when the connection drops and comes
  back. The gateway used to be created per connection, so every reconnect moved it to
  a new port and any browser tab left open on the old address went blank. It now
  belongs to the pair: the address survives a drop, a network change, a wake from
  sleep and even a restart of the other computer's DSH, and a tab recovers on its
  own. While no session is attached it still answers but proxies nothing. Only
  revoking the pair, or deleting its network, retires the address.
- A connection is no longer torn down by a brief interruption. WebRTC reports
  `disconnected` for a few lost packets, a changed network or a machine waking up and
  normally recovers within seconds; treating that as a failure meant every hiccup cost
  a fresh hole punch. A lost path is now given 20 seconds to recover, and a peer that
  stays away is still reported, with its reason, once that window passes.
- A reconnecting remote workspace no longer fails the moment it comes back. A message
  arriving in the instant between the connection opening and its identity being
  checked used to tear the whole connection down, which made roughly one reconnect in
  ten die immediately with “no direct path” and then quietly come back on a later
  attempt. The check now waits for itself; bytes are still only accepted once the
  peer's identity is verified.
- Your paired device credential now lives in the **native secret store behind the
  headless core** (macOS Keychain, Windows DPAPI) instead of an Electron-encrypted
  file. An existing credential from a previous version migrates itself once on first
  launch and keeps working; a core that cannot start falls back to the previous
  behavior instead of failing the app.
- Fixed a data-loss defect found during that migration: the macOS Keychain writer
  silently truncated any secret longer than 128 bytes and corrupted binary values.
  Secrets are now encoded and stored in chunks; no released version was affected.

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
