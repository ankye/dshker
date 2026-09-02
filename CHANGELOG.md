# Changelog

## 0.1.0 — Unreleased

- Adopted the Electron, Vite, Vue, and TypeScript desktop foundation.
- Replaced template identity, seeded content, and VFS service composition with
  the DSH Launcher bootstrap shell.
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
