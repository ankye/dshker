# Windows managed-Git and store parity fixes

## Context

The managed-workspace suite was developed against POSIX paths and macOS Git
behavior. On Windows, eleven tests failed — and behind two of them stood real
production bugs in the managed-installations path, not just test assumptions.

## Diagnosis

- `git fetch` importing a bundled mirror failed with `Filename too long`: the
  staging mirror path plus a pack file name exceeds Windows' 260-character
  MAX_PATH. This reproduces in production whenever the user's home path is long
  enough, independent of tests.
- `verifyManagedGitWorktree` and `inspectUnmanagedGitRepository` compared
  git-reported paths with exact string equality. Git for Windows reports
  `rev-parse --show-toplevel` with forward slashes, so every managed worktree
  verification on Windows failed as a "worktree mismatch".
- Store fixtures (`registry`, `service`, `installation-catalog`) hard-coded
  `pathStyle: 'posix'` or posix literals against native temp paths; the
  toolchain probe test asserted an empty environment that only macOS produces;
  the plugin-source test matched a posix-separator regex; the bundle-alias test
  requires file symlink creation, which Windows denies without the
  SeCreateSymbolicLink privilege.

## Decision

Production: `deterministicGitArguments` adds `-c core.longpaths=true` on win32
so git uses its long-path file APIs for deep staging layouts; git-reported
paths compare through `isSameRegisteredPath` (resolve + win32 case-insensitive)
for both worktree verification and unmanaged-repository inspection. Test-only:
fixtures derive `pathStyle` and persisted path literals from the platform (the
catalog fixture derives its absolute directory from `process.cwd()`'s root so
no machine-specific drive letter is committed), probe-spawn assertions compare
against the exact built environment object (the no-PATH/no-HOME proof is
preserved), the plugin-source regex accepts both separators, and the
symlink-dependent test probes capability once and skips with a documented
reason where symlinks cannot exist.

## Consequences

The full suite passes on Windows (360 passed, 2 skipped: the pre-existing
bundled-seed environment skip and the symlink-privilege skip). The long-path
and reported-path comparisons make managed installations actually usable on
Windows; both were invisible on macOS. `core.longpaths` stays win32-only so
deterministic arguments remain platform-pure.
