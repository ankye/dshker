# Changelog

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
