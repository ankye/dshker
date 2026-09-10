# Changelog

## 0.1.26 — 2026-09-10

- The Connect tab now matches the compact network-management layout: saved
  computers come first, testing and connection status remain visible, and add,
  edit and removal controls expand on demand. Local device IDs and membership
  settings live in separate disclosures; joining explains where to get the
  required network ID without hiding errors or offline status.

- Network management now presents aligned, compact rows with network names,
  device limits and an explicit current selection. Rename, capacity and deletion
  controls expand on demand instead of filling the list. Account and network IDs
  live in explained technical details; the selected device section uses the
  network name. Destructive controls remain separate with confirmation, and
  background reads no longer leave a generic success message above the list.

- A running launcher now comes online by itself. The coordinator heartbeat only
  runs while a device session holds the signal connection, and nothing
  established that session until the user happened to open the pairing screen.
  Until then a launcher that was open never reported its build, showed as
  offline to every other machine, could not be found for pairing, and could not
  be driven from the web console. Verified against the live coordinator: the
  device's last-seen moved from never to a live timestamp, and it now reports
  its version, platform and architecture.
- Devices in the same network are paired automatically, with no invite code and
  no approval step. Joining a network is the authorization, so requiring two of
  your own machines to exchange a code made membership grant nothing. The trust
  boundary is unchanged: adoption still requires an active binding in a shared
  network owned by the same user with neither device revoked, which is exactly
  what the invite path verified. Peers are derived from the device's own
  bindings, so the request cannot be aimed at another account.
- Buttons across the app had no surface of their own and fell back to the
  browser's default grey, a colour the theme does not contain, so primary and
  secondary actions were indistinguishable. Destructive actions were styled in
  seven places but never defined at all, meaning deleting a network looked
  exactly like reading one; they now carry a danger outline. Keyboard focus is
  visible on every variant.
- The Network & account screen is grouped into cards instead of one flat column
  of headings, status lines and bare buttons separated only by rules.
- Windows packages contained no peer helper at all, so every P2P feature was
  unavailable there with no build error to show it. The packaging filter used
  electron-builder's `${platform}`, which expands to `win`, while the launcher
  resolves the helper by `process.platform`, which is `win32`. macOS and Linux
  happened to agree with the variable, so only Windows was affected. Each
  platform now names its own directory literally, and a package can only contain
  its own helper.
- The update check now shows what changed. It previously reported only that a
  newer version existed, so the only way to find out what was in it was to open
  GitHub. The release body appears under **Settings → Updates** as plain text:
  it is remote content, so control characters are stripped, its length is
  bounded, and it is never rendered as markup. A release without a body simply
  shows no notes instead of an empty heading.
- P2P was silently dead in every packaged build, on every platform. The helper's
  integrity manifest is written when the Go binary is built, but packaging then
  code-signs every executable, which rewrites the binary and invalidated the
  recorded digest. The launcher verifies that digest before starting the helper,
  so it refused: the app opened normally, no P2P feature worked, and the device
  stayed offline forever while reporting an older build. Nothing failed at build
  time. The manifest is now resealed after signing, and the release gate verifies
  the shipped helper against the digest the runtime reads, so this cannot ship
  again unnoticed.
- Remote connection surfaces now read as product rather than tooling. The device
  limit used a native select, which the workspace design gate forbids because its
  popup cannot carry the dark operational palette; it now uses the existing
  ThemedListbox. Copy that exposed implementation vocabulary ("readback", "read
  user again") is stated from the user's point of view while keeping the
  distinction between an unconfirmed result and a confirmed negative. Account and
  enrollment identity now rank a name above its raw identifier instead of
  rendering every fact at one weight, and secondary refresh actions no longer
  stretch to full card width as though they were the primary action.
- The signed-in remote-connection card loads its own data on entry. The network
  list required a click, unlike every sibling panel, so the card opened claiming
  no networks were loaded. Entry reads for one service are now queued instead of
  refusing each other, which also fixes the enrollment panel: it skipped its only
  automatic read whenever the account card was still reading, and reported an
  unknown enrollment state as a result. Manual refresh remains for resolving a
  write whose result was never confirmed.
- Network reach is now a shared fact rather than something each surface derived.
  This computer's session with the coordinator is tracked in the main process,
  exposed through the management contract, and shown in the status bar so it is
  legible from every route. The Connect tab previously derived a network status
  from pair connection stages, so a computer with no paired peer reported itself
  offline while the device directory listed the same machine as online. A down
  session now states the refusal that caused it instead of an unexplained
  "offline", and an unread session reads as unknown rather than as offline.
- The network status in the status bar is filled at shell start instead of when
  Remote connections is first opened, so the first screen no longer shows an
  unknown status that only resolved after visiting that tab. A session is also
  ended when the runtime is lost, rather than continuing to claim reach the
  computer no longer has.
- Coming online is now maintained rather than attempted once. Sessions are
  established after the window opens, so the first status read could observe a
  state that was already stale and nothing corrected it; main now pushes session
  changes to the window. A periodic sweep also retries any service that is not
  online, so a coordinator that was briefly unreachable, a network change or a
  wake from sleep no longer leaves the launcher offline for the rest of its run.
  Services already online are left untouched by the sweep.
- A paired computer's Browser tab now reports its connection state, matching what
  an SSH tab has always reported. The peer branch hardcoded that state to
  undefined, so the tab could not show whether it was connecting, ready or
  failed. Both sources are projected to one address-free shape: an SSH `ready`
  carries a URL, while a peer entry point stays in the main process. A revoked
  pair reads as disconnected rather than failed, and an unread connection list
  stays distinct from a confirmed disconnected state.
- This candidate remains an interop-testing prerelease: not marked latest,
  not in the stable update feed.

## 0.1.25 — 2026-09-08

- Deleting a configured P2P coordinator server is now tolerant: it is a
  purely local operation, so a server that is no longer reachable (or a legacy
  service record that no longer passes strict certificate re-validation) does
  not block removal. The record is stripped, its computers dropped, and the
  identity forgotten; previously this surfaced as p2p.internal_error.
- App icons are regenerated from the otter brand mark (dshker-otter-icon-v1)
  as rounded-corner, transparent-corner marks for the installer/bundle, the
  in-app sidebar logo, and the repo-root icon.png.
- Account registration form added to the Network & account tab (email +
  password) alongside login, with localized handling for duplicate email,
  invalid credentials, and the per-user 2-network limit.
- This candidate remains an interop-testing prerelease: not marked latest,
  not in the stable update feed.

## 0.1.24 — 2026-09-08

- Network & account tab is now a **login + register page** when signed out:
  register an account with an email and password, or log in with that email
  (server identifies users by email; public POST /v1/register).
- The signed-out heading and both forms are localized in zh-CN and en-US;
  register failures (duplicate email, invalid credentials, network limit)
  show typed localized messages instead of a bare code.
- Deleting a configured P2P coordinator server is supported from the Connect
  tab with an inline confirm (removeService); the account tab no longer
  bounces to Connect when no server is selected; enrollment stays login-free
  and visible while signed out.
- This candidate remains an interop-testing prerelease: not marked latest,
  not in the stable update feed.

## 0.1.23 — 2026-09-08

- Remote connections is now two sub-tabs inside the remote route: **连接/Connect**
  (SSH management, P2P server configuration and login-free **join by networkId**
  that enrolls the local device without an account) and **网络与账户/Network &
  account** (login page; once signed in: network management, device pairing, and
  the registered computers list). A joined-but-signed-out device cannot mesh and
  is guided to the login form; tabs never auto-switch and no state is faked.
- Networks carry a **device capacity limit** (default 10). The signed-in owner
  can raise it to 20 or 30 in the network management panel; joins to a full
  network are refused with a clear error and never evict bound devices.
- **Linux support**: macOS, Windows and Linux are all first-class. Peer channels
  use the same owned Unix socket on Linux as on macOS; the Go peer helper builds
  for linux x64/arm64; installers are produced as **AppImage and deb** for both
  Linux architectures, plus the existing macOS DMGs and Windows NSIS installers.
- This candidate remains an interop-testing prerelease: it is not marked latest
  and does not enter the stable update feed.

## 0.1.22 — 2026-09-08

- **P2P interop prerelease.** Add self-hosted peer-to-peer DSH connections so two
  paired computers talk directly (Pion WebRTC ICE + DTLS + DataChannel) over a
  user-deployed Go coordinator (HTTPS/WSS/STUN), without SSH, port forwarding or
  copying DSH tokens.
- Pairing is membership-based: configure the shared service, enroll this
  computer, approve the peer, and pin the confirmed fingerprint before anything
  connects. Revocation is persisted and a revoked computer can never reconnect.
- Remote workbench: browse only user-authorized remote roots (real platform
  path rules, symlink/junction escape refused), open and run tasks on the remote
  DSH, and read back results from the remote authority. Remote work survives a
  disconnect; a lost link is never reported as a stopped task and nothing is
  auto-retried.
- Shared service editing is transactionally locked: a new address is accepted
  only when it proves the same pinned identity, any busy peer blocks the save,
  and a failed save leaves the stored config byte-identical.
- **Experience improvements in this candidate:** member rows are identity-first
  (name + remote device id), connection stages live-poll every two seconds, and
  the three fixable connect failures (`peer_offline`,`direct_unavailable`,`connection_busy`)
  explain themselves inline, with a one-click "open workbench" entry once ready.
- This is a Win/Mac interop-testing prerelease: it does not mark `latest` and is
  not in the stable update feed. All 92 user-facing P2P error codes are
  documented and covered by a guard test.

## 0.1.21 — 2026-09-06

- Add managed DSHKer-to-DSHKer remote connections over supervised loopback SSH
  tunnels, with short-lived peer credential exchange and one fixed Run tab per
  registered computer.
- Add full-path connection testing plus clear red/green live and test status
  indicators. SSH private keys and passwords are never transferred or stored.

## 0.1.20 — 2026-09-05

- Give macOS packaged smoke the same 60-second startup budget as Windows so
  slow Intel runner evidence cannot race the output reader.

## 0.1.19 — 2026-09-05

- Keep geometry measurements in smoke evidence while gating on deterministic
  completion of every constrained height/route probe across macOS runners.

## 0.1.18 — 2026-09-05

- Recognize electron-builder's `win-arm64-unpacked` output during metadata
  generation and packaged smoke discovery.

## 0.1.17 — 2026-09-05

- Disable the invalid Windows `NUL` global Git config path used by ARM Git.
- Exercise short-height shell constraints without mutating the native window.

## 0.1.16 — 2026-09-05

- Probe responsive heights through Chromium viewport metrics so Intel Mac CI
  does not invalidate the native BrowserWindow during smoke.
- Include the failing Git operation and stderr in Windows ARM seed diagnostics.

## 0.1.15 — 2026-09-05

- Keep Intel Mac height probes within the native display work area so Cocoa
  does not destroy the smoke window when the runner is shorter than 820px.
- Preserve the original Windows ARM seed error when cleanup is temporarily
  locked, and retain seed logs when preparation fails before packaging.

## 0.1.14 — 2026-09-05

- Resize packaged smoke content through Electron's content-area API so macOS
  Intel height adaptation does not invalidate the native window frame.
- Keep Windows ARM seed cleanup warnings explicit without masking clone or seed
  preparation failures.

## 0.1.13 — 2026-09-05

- Size the packaged smoke window to the native display work area so Intel Mac
  runners can complete resize and renderer evidence without window teardown.
- Treat only a Windows transient temp-clone lock as deferred cleanup; all other
  seed preparation and cleanup errors remain release-fatal.

## 0.1.12 — 2026-09-05

- Keep the macOS Intel packaged smoke window valid during the short-height
  resize probe.
- Retry transient Windows seed-directory locks while preserving persistent
  cleanup failures as release blockers.

## 0.1.11 — 2026-09-05

- Added native release packages for macOS Intel, macOS Apple Silicon, Windows
  x64, and Windows ARM64.
- Launcher update discovery now selects the exact installer for all four
  supported platform and architecture combinations.

## 0.1.10 — 2026-09-04

- Keep the Windows packaged smoke window on-screen so resize-triggered frame
  evidence cannot stall on a compositor-suspended off-screen window.
- Record explicit renderer-paint and first-frame capture stages in packaged
  smoke diagnostics.

## 0.1.9 — 2026-09-04

- Hardened the Windows packaged-app release smoke gate with an explicit startup
  budget and native startup-stage diagnostics.

## 0.1.8 — 2026-09-04

- Hardened the Windows packaged-app release smoke gate with an explicit startup
  budget and preserved child-process timeout diagnostics.

## 0.1.7 — 2026-09-04

- Added a single-source Launcher version identity shared by application metadata,
  installer names, release manifests, update comparisons, and release tags.
- Added non-blocking GitHub Releases checks at startup and an explicit update
  panel in Launcher settings for the exact macOS arm64 or Windows x64 installer.
- Added passive startup notices for newer stable releases without silent
  replacement or restart.
- Improved embedded WebView rendering diagnostics, zoom handling, and device
  scale reporting for clearer cross-DPR output.
- Added daily token usage charts and completed the responsive shell and settings
  layout refinements.

## 0.1.0 — Unreleased

- Adopted the Electron, Vite, Vue, and TypeScript desktop foundation.
- Replaced template identity, seeded content, and VFS service composition with
  the DSHKer Launcher bootstrap shell.
- Added explicit Git, Node.js, and pnpm executable registration with shell-free
  identity probes.
- Added managed Git mirrors, exact-SHA detached worktrees, and explicit branch,
  tag, and commit selection under the Launcher-owned Harness root.
- Added one-click launch of the selected worktree's standard `dsh web --no-open`
  command with a bounded stdout and stderr console stream.
- Runtime readiness now comes from the URL the started process announces. The
  run page no longer loads a hardcoded `127.0.0.1:3080`, which both missed a
  non-default port and dropped the session credential in that URL.
- Replaced every native select element with a themed ARIA listbox so control
  popups carry the application palette.
- Renamed the shared foundation package to `@desktop-workspace/foundation` to
  match the workspace boundary contract.
- Removed unwired descriptor and child-IPC supervisor scaffolding for a transport
  this release does not implement; the rejected alternative is recorded in the
  change's design record.
- Every route now scrolls inside the workbench stage and adapts to the window
  height. The shell is pinned to the viewport so the topbar and statusbar stay
  visible, the Console log stream is bounded instead of growing without limit,
  and the run frame inherits available height rather than a fixed one. Packaged
  smoke evidence checks all routes at three window heights.
- Corrected the bundled-seed contract to DeepSeek Harness's real
  `@deepseek-ai/dsh-web-app` bundle; there is no `dsh-desktop-app` package.
- Unified the bundled seed on one staged layout, so `seed:prepare` output is
  accepted by both the manifest and Git-bundle verifiers and by the packaged
  runtime.
- Added packaged-app smoke instrumentation so release evidence proves the real
  artifact mounts its shell, reaches every route, and paints real content.
- Fixed macOS release smoke to locate arch-suffixed build output such as
  `release/mac-arm64`, and to report the installed bundle id the manifest records.
- Added a DSH web port setting under Advanced options, persisted outside the
  Harness checkout so switching revisions keeps the selection. A fixed port is
  passed as `dsh web --port`; the automatic default still omits the flag and
  reads the port from the URL the child announces.
- Separated the two settings surfaces: Advanced options now owns DSH launch
  configuration, and Settings owns Launcher preferences only.
- Fixed the display-language control, which previously changed nothing because
  every surface built its translator from a hardcoded initial locale. Language
  and theme are now shared reactive state, persisted across restarts.
- Removed the NPM acceleration toggle: it had no main-process implementation and
  silently did nothing when switched.
- Packaged smoke now also captures a scrolled frame per route, so controls below
  the first fold appear in design-review evidence.
