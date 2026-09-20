# Auto-open command-line output for Launcher operations

## Request

Open the bottom command-line log automatically while one-click launch, Core/version updates, and plugin operations run.

## Interaction contract

- An accepted Launcher-owned operation opens the shell-level console tail immediately, so progress and failure context are visible without navigation.
- Closing the tail is respected for the remainder of that operation; incoming lines do not reopen it.
- Later accepted operations open it again. Passive output that arrives without a new operation keeps the unread-dot behavior.

## Implementation

- Added an idempotent `openConsoleDrawer()` state action.
- AppShell watches the shared `activeOperation` transition, covering launch, Core/version, and plugin operations without coupling the domain composable to shell UI.
- Added OpenSpec, changelog, and state coverage.

## Validation

- Focused shell coverage: `npm test -- --run src/app/shell/tests/consoleDrawerState.test.ts src/app/shell/tests/statusbarControlWiring.test.ts src/app/shell/tests/ConsoleDrawer.test.ts src/app/shell/tests/launchNavigatesToConsole.test.ts src/app/domains/launcher-harness/tests/useLauncherHarness.test.ts` — 5 files, 28 tests passed.
- Full regression: `npm test -- --run` — 164 files, 1,436 tests passed.
- Static/build checks: `npm run type-check`, `npm run build`, `npm run build:electron`, `npm run architecture:check`, changed-file `npx prettier --check ...`, and `git diff --check` passed. Repository-wide `npm run format:check` still reports the same 12 pre-existing files outside this change (including the untracked workspace lockfile); no unrelated formatting was rewritten.
- Visual/root checks: `npm run visual:smoke` passed all findings; `node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json` returned `ok: true` with no issues.
