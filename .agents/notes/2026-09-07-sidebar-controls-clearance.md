# Hidden sidebar floating controls clearance

Track: desktop. Owner: `add-managed-harness-desktop-shell`, tasks 9.1–9.2.

The user's screenshot shows the two Launcher controls covering the guest's
bottom-left settings action when the Launcher sidebar is hidden. Only that
state overlays the guest; expanded/collapsed controls already live in the rail.

`src/styles/base-shell.css` now defines one shared `--sidebar-controls-offset`:
0rem in the ordinary rail and 4rem when hidden. Both button bottom positions use
it. At the default 16px root size this raises them 64px, retains 40px buttons
with an 8px gap, and puts their lower edges 76px and 124px above the stage bottom.
The hidden overlay still ignores pointer input outside the two buttons. No
guest styling, zoom, runtime, IPC, persistence, or existing dirty work changed.

Validation:

- Focused ShellSidebar, sidebarState, and ConsoleDrawer suites: 14 tests pass.
  The new stylesheet readback checks expanded → collapsed → hidden → expanded,
  both computed bottom expressions, shared offset, availability, and pointer
  transparency. The real stylesheet is read because Vitest skips CSS imports.
- Full regression with canonical macOS TMPDIR: 95 files / 559 tests pass.
- Environment, architecture, types, service isolation, static visual checks,
  strict OpenSpec validation, Web build, and Electron build pass.
- Desktop workspace validator passes when run from `desktop_workspace`.
- Source sizes: base-shell.css 486 lines; ShellSidebar.test.ts 137 lines.
- Compiled renderer CSS contains the new offset; compiled assets do not
  contain the new test title. No imports or production entry points changed.
- Native smoke uses the built app's existing `--dshker-smoke`/environment path,
  which registers real services under disposable managed roots and skips
  Harness bootstrap. Evidence: `.run/sidebar-controls/native-smoke.json`.
  Seven routes, 792/560/420px content heights, real preload, mounted text,
  nonblank/non-single-color first frame, and no renderer errors are checked.

Limits:

- Native shell smoke is not proof of a click on the user's live DSH guest
  settings button. A raw public-UI interaction ledger and Windows evidence are
  still absent; `test-gates/sidebar-controls-interaction.json` stays diagnostic.
- Scoped manifest static validation passes. Default test-integrity verification
  fails closed on existing remote/P2P and console-color production changes
  outside this CSS-only manifest; no complete acceptance pass is claimed.
- This change does not replace or restart the installed DSHKer app, alter its
  running DSH process, commit, push, package an installer, or publish a release.
