# Console operation activity and the push feed

## Context

The Console rendered only `dsh web` child output, and only while the checkout was
`ready`. Every Launcher operation — core update/switch, plugin install/update/
remove/manage, and the bundled first-run preparation — ran silently, `start()`
cleared the console before each launch, and a preparing/missing/invalid checkout
hid even retained output behind an empty state. The one delivery mechanism was a
1.5 s state poll, so streamed output lagged and stopped entirely while an
operation held the busy flag.

## Decision

Every Launcher operation now records launcher-marked console steps (start,
each Git/pnpm child, completion, and the failure reason) through
`#reportOperation`, and operation children stream their stdout/stderr fragments
into the same feed via `runText`'s new `onOutput` seam. `start()` no longer
clears the feed; it appends a launch separator instead. Bundled-seed
preparation reports its steps through `setBootstrapState` events and a new
`onActivity` callback wired from `main.ts`.

Delivery is event-driven. `LauncherHarnessService.onConsoleAppend` notifies the
IPC layer, which broadcasts each appended entry on the single named
main-to-renderer channel `launcher-harness:console-appended`. The frozen
preload exposes it as `launcherHarness.onConsoleAppend(listener): () => void` —
the bridge's first and only push operation. Entries carry a monotonic `seq`, and
the renderer unions snapshots with pushed entries by that sequence
(`mergeConsoleEntries`), because a `getState` reply can overtake an append
event; replacement would roll the feed back and blind appending would
duplicate. The renderer's periodic read remains only for low-frequency state
transitions (preparing/starting/running).

The Console view now renders the feed for every readiness kind. A not-ready
checkout shows its reason in a compact notice above the retained output, and the
not-ready empty state appears only when nothing has ever been observed.

## Consequences

Users see update, switch, install, plugin, and launch activity live, including
failure reasons, exactly in the situations where DSH Web never starts. The
console stays push-driven, so no polling cadence gates output latency, and no
`getState` (which spawns several Git reads) runs merely to fetch logs.

Operations also append their records to the durable log file through an
append-mode stream (`#openOperationLogStream`): a force-quit during a stalled
switch leaves the last recorded step on disk instead of only in memory, while a
launch keeps its fresh-file truncation semantics. Each switch step records its
elapsed completion (`formatLauncherStepCompletion`) because the slow Windows
steps — `git clean` of a full `node_modules` took ~18 minutes in the incident
below, with no output of its own — are exactly the ones users read as a freeze.
Git suppresses its progress percentages when stderr is a pipe, so fetch and
checkout pass `--progress` explicitly; steps that still print nothing (clean)
re-assert themselves with a silence-gated heartbeat
(`formatLauncherStepHeartbeat`, every 10s once the feed has been silent 20s — a
streaming child silences the heartbeat). The statusbar's indeterminate slide is
neutralized under `prefers-reduced-motion` (and shows no progress even while
animating), so version operations now render a determinate step-position fill:
the renderer counts completed steps from the pushed feed
(`computeOperationStepProgress` — fetch adds the seventh step to update/branch
switches, a plain commit switch has six) and appends `Step 3/7 · 42s` to the
statusbar text; width changes at step boundaries move without any animation.
Launch-child line buffering and
URL-announcement detection moved to `ChildOutputObserver`, checkout readiness to
`readHarnessReadiness`, pnpm command resolution to `launcher-harness-commands`,
and child termination to `child-termination`, keeping the service within its
line budget. A per-version-directory switch (materialize new version, flip a
pointer, delete the old directory off the critical path) was designed and
shelved after the incident review: streamed progress plus heartbeats already
remove the perceived freeze, and the migration cost outweighed the benefit for
now; the managed-installations path already offers mirror+worktree installs.

Incident record (2026-09-04, Windows): a user update stalled at the static
"switching core" status. Forensics showed `git fetch` finished (FETCH_HEAD
0:11), `git clean -xdf` ground through `node_modules` for ~18 minutes with zero
output (released 0.1.6 logs nothing during operations), and the app was killed
before `git checkout` wrote anything — HEAD and the index untouched, no stale
`index.lock`. The checkout was left unbuilt (`node_modules` and
`apps/cli/lib/bin.js` gone) and was repaired by re-running checkout, install,
and build; registry and GitHub connectivity were fine, and pnpm's Windows
`.CMD`-to-`pnpm.mjs` resolution was verified correct.

`LauncherHarnessConsoleEntry` gained a required `seq`; fixtures that construct
entries updated accordingly. Operation wrappers assert `stopped` before fetching
in `update()`/`switchBranch()`, so a busy refusal fails earlier with the same
typed code instead of after a fetch.
