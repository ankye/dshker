# Launcher Core version switching in the existing checkout

The Launcher now prepares Core revisions in a single working directory. A fresh
install uses `harness`. An upgraded install retains its active linked worktree
at `versions/<original-commit>`, which preserves its existing dependency links.
The new version record distinguishes that stable checkout anchor from the
selected commit. It reads the old two-field format explicitly and writes the
new format on the next explicit selection.

- Select a cached branch, release, or commit without a Git fetch. Core refresh
  fetches origin branches and tags, and Update fetches master and tags.
- Switch to the verified exact commit in detached HEAD. The branch label records
  the selected origin branch. Local branch refs stay intact.
- Require the core to report the DSH Web subject stopped or absent. Refuse
  staged or unstaged tracked changes. Git protects colliding local files and
  leaves other files in place when switching.
- Publish a non-launchable preparation record before changes. Reuse local
  dependencies, install from the lockfile, build, reconcile the web profile,
  then verify readiness and exact HEAD before writing the ready record. An
  interrupted preparation can be explicitly retried in the same checkout.

No existing worktree is moved or deleted. No installed Launcher profile was
used for a switch or build in this change.

## Verification

- Real local Git tests cover stable path and dependency reuse, legacy checkout
  anchoring, tracked modifications, ignored and ordinary file collisions,
  changed ignore rules, branch tips outside master, and interrupted-build retry.
- Main-process tests cover refusal while an attached core reports a running
  child, launch gating on the preparation record, and ready path handoff.
- Renderer tests cover selecting and retrying from an incomplete version state.
- Full Vitest run passed with 2,111 tests and 2 skips. Type, format, architecture,
  service isolation, visual smoke, desktop workspace validation, strict OpenSpec
  validation, and Web and Electron builds passed.
- The macOS Electron renderer mounted in an isolated profile. Full native Harness
  rebuild and launch after switching, including Windows dependency junctions,
  remain tracked in OpenSpec task 13.3.
