# Per-version directories replace the in-place checkout switch

## Context

Version switches mutated the single `~/.dshlauncher/harness` checkout in place:
`git clean -xdf`, `checkout --detach`, install, build. Two consecutive
incidents on Windows showed the design was fragile. First, an ~18-minute silent
`git clean` was read as a freeze and force-quit mid-way, leaving the checkout
unbuilt (the console/step/heartbeat work made that visible). Second, the same
clean failed outright on pnpm's deeply nested node_modules (MAX_PATH > 260)
even with `core.longpaths` on the managed-git runner — the Launcher's own
`runText` Git calls lacked the prefix — so a switch aborted with
node_modules/bin.js deleted and the version list blanked because readiness was
`invalid`. The user's direction, repeated three times, was the fix: build each
version in a new directory, then switch, then delete the old version.

## Decision

`harness/` becomes the main Git repository only (history, refs, fetch target —
never built, never cleaned). Each version is a `git worktree --detach` under
`versions/<sha40>/` with its own node_modules and build output. The active
version is named by `harness-current.json`, written atomically (temp + rename)
only after install, build, and profile reconciliation all succeed in the new
directory. A failed or interrupted materialization leaves the active version
untouched; an interrupted version-directory deletion is retried on the next
switch, off the critical path, in the background. Reused versions switch
instantly without rebuilding.

Main-process Git calls all carry the `launcherGitArguments` prefix
(`-c core.longpaths=true` on win32), so cleanup of deep pnpm trees succeeds.
The bundled seed publishes only the repository (its install/build steps were
removed — the version materialization builds once). Existing single-checkout
installations migrate on first launch: `prepareCurrentVersion` materialises the
main repository's HEAD as the first version directory; the old working tree is
left untouched. Version-op gates now require only a stopped child and a main
repository (`.git`), so an unbuilt active version can be repaired by switching
again; plugin and launch operations still require the built active version.
Operation step/start/failure recording moved into `LauncherOperationReporter`
(owning its own append-mode durable log handle) and version materialization
orchestration into the version store, keeping the service within its line
budget.

## Consequences

Switching is atomic from the user's perspective: the current version keeps
working until the new one is ready, and the version list renders from main
repository history even while a version is unbuilt (non-ready states carry
recovery metadata and the UI shows a repair notice instead of "no commits").
Storage per materialized version is reduced by the shared pnpm store
hard-links; replaced versions are deleted in the background. The renderer
step-progress count now maps to the materialization pipeline (remove residue,
verify ancestor, worktree, install, build, reconcile).
