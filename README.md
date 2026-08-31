# DSH Launcher

DSH Launcher is the macOS and Windows desktop shell for operating a selected
DeepSeek Harness checkout. The launcher manages exact Harness worktrees,
plugin generations, configuration, and settings in independently registered
directories. The Harness-owned `$DSH_HOME` or `~/.dsh` remains outside Launcher
management and is reused when a worktree revision changes.

The repository is intentionally a submodule of
`desktop_workspace/apps/dsh-launcher`, but it owns its source, tests,
packaging, documentation, and release process.

## Current state

The launcher starts a security-isolated Electron window at `dsh-app://launcher/`
and exposes only named typed IPC operations. Working today:

- Registration and validation of explicit Git, Node.js, and pnpm executable
  identities.
- Managed Git mirrors, exact-SHA detached worktrees, and explicit branch, tag, or
  commit selection under the Launcher-owned Harness root.
- One-click launch of the selected worktree's standard `dsh web --no-open`
  command, with its bounded stdout and stderr streamed into the Console view.
- A run page that loads only the loopback URL the started process announced.

Readiness comes from the child's own startup URL line, which may carry a session
credential, so the launcher never predicts a port or rebuilds the address. A
private descriptor-bound child IPC bridge would prove more, but it needs a
Harness-side counterpart that does not exist and that this change does not add;
the rejected alternative is recorded in the change's `design.md`.

Still open: Settings relocation UI, SHA-bound plugin generations, a real
clone-through-stop smoke test, and signed macOS and Windows packages. See
`openspec/changes/add-managed-harness-desktop-shell/tasks.md`, which records each
task with its evidence.

## Development

Requirements:

- Node.js `^20.19.0 || >=22.12.0`
- npm `>=10.0.0`

```bash
npm ci
npm run dev
```

Run the focused checks:

```bash
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run seed:verify
npm run build
npm run build:electron
```

The same npm commands work in Windows PowerShell.

## Repository layout

- `electron/` — Electron main and preload code.
- `src/app/shell/` — dense operational shell and presentation.
- `src/app/domains/` — Launcher product domains, each with a public `index.ts`.
- `src/app/shared/controls/` — themed controls replacing native form widgets.
- `src/app/shared/i18n/` — typed locale dictionaries.
- `src/styles/` — application tokens and shell layout rules.
- `src/shared/` — typed renderer/main contract.
- `packages/desktop-foundation/` — reusable, app-neutral helpers.
- `docs/` — architecture, development, integration, CI, and release guidance.
- `openspec/` — approved product change records.

## Release stance

Source checks are not release proof. macOS and Windows packages must separately
prove signing, renderer isolation, artifact contents, and startup of an exact
compatible Harness checkout. See [docs/release.md](docs/release.md).
