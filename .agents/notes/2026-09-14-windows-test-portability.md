# The test suite is not portable to Windows yet

Date: 2026-09-14

## What prompted this

The quality workflow only ever ran on Linux (`runs-on: ubuntu-latest`), while
the packaging workflow builds installers on Windows without running the suite.
So no Windows run of the unit tests had ever happened, locally or in CI, which
is exactly the gap the project's own "tests pass on macOS and Windows"
requirement depends on.

## What a Windows run actually found

Two different machines, two different partial failures — the suite is not
portable yet, in ways that need real fixes rather than a gate:

On a Windows machine with a broken git install (the scoop app directory is gone
and only an orphaned shim remains, so `git` cannot run at all), 5 tests fail:

- `electron/main/managed/launcher-harness-service.test.ts` —
  `cleanLauncherHarnessCheckout` removes ignored and untracked build residue
- `electron/main/managed/managed-plugin-sources.test.ts` — converges a dirty
  owned clone, and surfaces a refused Git update as a plugin failure
- `electron/main/managed/git/mirror.test.ts` — resolves and materializes a
  bundled branch
- `electron/main/managed/git/worktree.test.ts` — resolves an explicitly fetched
  branch and materializes a clean detached worktree

Every one of them spawns git, and the failure is the shim's own error
(`Shim: Could not create process ... scoop\apps\git\current\bin\git.exe`).
These are environment, not product: they pass wherever a real git exists.
`scoop install git` cannot repair it because scoop's own helper errors out.

On the GitHub Windows runner, where git is present, the managed-Git tests pass
and a different set fails:

- four tool test files fail to load: `tools/environment-check.test.mjs`,
  `tools/performance-check.test.mjs`, `tools/release-artifacts.test.mjs`,
  `tools/visual-smoke.test.mjs`
- `src/app/shell/tests/versionRefreshFeedback.test.ts` fails its pending-refresh
  labelling assertion

Result on that run: 143 files passed, 5 failed, 2 skipped; 1216 tests passed,
1 failed, 10 skipped.

## Root cause: the checkout, not the code

All five failures on the Windows runner had one cause. The repository had no
`.gitattributes`, so a Windows checkout applied `core.autocrlf` and rewrote LF to
CRLF. That broke two unrelated-looking things:

- `tools/*.mjs` all begin with a shebang. With a CRLF ending, vitest's transform
  rejected every one of them with `SyntaxError: Invalid or unexpected token`.
  Those four files are exactly the four suites that failed to load.
- `versionRefreshFeedback` asserts the exact LF-formatted text of a `.vue` file,
  so it failed on the `\r\n`: `expected '<script setup lang="ts">\r\nimport { …'
to contain 'case 'refresh':\n …'`.

The decisive clue was that the same suite passed on a Windows machine whose source
came from a tar (LF preserved) and failed on CI (checked out with autocrlf), while
the failures were parse errors rather than missing dependencies.

## Fix

`.gitattributes` now pins `eol=lf` for every text file, with binary assets listed
explicitly. The index already stored every text file as LF (700 `i/lf`, 19 binary,
zero `i/crlf`), so no renormalization was needed — only the checkout behavior
changed. Prettier has no parser for `.gitattributes`, so it joined
`.prettierignore` rather than breaking the format gate.

The Windows job was re-added in the same change and **now passes on CI**:
`✓ Verify launcher (Windows)` runs formatting, architecture, type checks and the
full unit suite on a real Windows checkout. That is the durable, automatic
evidence the "both platforms" requirement needs, instead of a hand-run.

## Remaining caveat

The Windows machine used for manual verification has no usable git (the scoop app
directory is gone and only an orphaned shim remains; `scoop install git` cannot
repair it because scoop's own helper errors out). The five managed-Git tests
cannot run there and fail as if the product were broken. They pass on the CI
Windows runner, which has real git, so the evidence exists — but making them skip
with an explicit "git unavailable" reason would be more honest on such a machine.
