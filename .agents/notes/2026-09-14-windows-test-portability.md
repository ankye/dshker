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

## Decision

A Windows gate was added and then reverted: enforcing it now would leave main
red for pre-existing reasons unrelated to the change that introduced it. The
portability fixes come first, then the gate. Formatting, architecture and type
checks _did_ pass on Windows, so those are ready to gate whenever the suite is.

## Next steps

1. Fix the four `.mjs` tool tests so they load and run on Windows.
2. Fix the `versionRefreshFeedback` assertion for Windows.
3. Make the managed-Git tests skip with an explicit reason when no usable git
   binary is present, instead of failing as if the product were broken — or
   require git in the environment and say so.
4. Re-add the Windows job to `quality.yml` once 1-3 are green.
