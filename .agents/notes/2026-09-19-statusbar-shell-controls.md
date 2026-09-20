# Shell controls move into the status bar

## Scope

The sidebar presentation control and the console tail control were floating 2.5rem circles pinned to a
rail inside `.sidebar-region`. Both now live in the status bar as a leading icon group. This is renderer
presentation only: no IPC contract, persisted record, or DSH-owned path changes.

## Decisions

- The status bar is the single home for both controls. It already spans every route, which is why it can
  own them without the hidden-state clearance the rail needed.
- The rail is deleted, not merely relocated. `--sidebar-controls-offset` and the 4rem hidden-state raise
  no longer exist, because the condition they compensated for — Launcher chrome floating over the Run
  guest's bottom-left footer — is now unreachable. A hidden sidebar uses `display: none` instead of a
  pointer-transparent overlay, so the stage takes the full window width.
- The control group renders outside the busy/idle branch of the status bar. A multi-minute switch must not
  take navigation chrome away from the user, so the busy strip is appended after the controls rather than
  replacing the bar's contents.
- Controls are 1.375rem inside the existing 1.875rem bar and use the quiet `--radius-sm` treatment rather
  than the rail's circular floating style; the circular rim only existed to host a badge on a floating dot.
  The unread badge moved to the button's top-right corner.
- `justify-content: space-between` was replaced with `.statusbar-controls + * { margin-left: auto }`.
  Keeping space-between would have spread the controls and the read-only text across the whole bar.
- The sidebar keeps its `state` prop: it still renders expanded cards, a collapsed rail, or nothing. It no
  longer receives label or console props, and emits only `select`.

## Spec and gate impact

- `add-managed-harness-desktop-shell` owns these requirements (`openspec/specs/` is empty, so a standalone
  MODIFIED delta had no target). The sidebar requirement dropped its floating-control sentence and its
  "Hidden sidebar controls must not cover guest settings" scenario; a new "Status bar owns the sidebar and
  console tail controls" requirement states the replacement contract. A duplicate sidebar-cycle scenario
  that had been misfiled under the Token usage requirement was removed.
- `test-gates/sidebar-controls*.json` are superseded by `test-gates/statusbar-controls*.json`. The retired
  contract's only workflow asserted the 4rem raise of controls that no longer exist.
- `console-severity-interaction.json` now selects `.statusbar-console-toggle`.
- `visual-smoke.mjs` replaced `shell.sidebar-toggle` — which only grepped AppShell for `t('nav.collapse')`
  and would still have passed after the move — with `shell.statusbar-owns-chrome-controls`, which also
  asserts the rail and its offset are gone.

## Evidence

`npm run format:check`, `npm run type-check`, `npm run architecture:check`, `npm run environment:check`,
`npm run service:smoke`, `npm run visual:smoke` (27 findings), `npm test -- --run` (160 files / 1411 tests),
`npm run build`, `npm run build:electron`, and
`node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json` all pass.
`openspec validate add-managed-harness-desktop-shell --strict` passes.

Rendered-geometry proof against the built `dist/assets/*.css` in a real browser: the bar stays 30px tall with
22px controls inside it; the control group leads at x=8 while protocol, scope, and network trail from x=894;
the badge sits within the console button's bounds; a hidden sidebar collapses to `display: none` and gives the
stage the full 1280px; the busy strip starts after both controls with their positions unchanged; and nothing
overflows at the 620px narrow breakpoint.

## Not verified

`npm run electron:renderer-smoke` fails with "Electron renderer debugger target not available: fetch failed".
This reproduces identically on a clean stash of these changes, so it is pre-existing and not caused by this
work. Task 11.2 therefore stays open: real macOS and Windows interaction evidence, including a DSH guest
footer click with the sidebar hidden, has not been collected.
