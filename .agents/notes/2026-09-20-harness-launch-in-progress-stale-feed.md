# Stale launch-in-progress state after stop

## Report

After DSH Web was stopped, the next launch still returned `managed.harness_launch_in_progress`.

## Root cause

`LauncherRuntimeFeed.stop()` only cleared its interval. A `drain()` already awaiting `runtime.status()` could finish after the explicit stop and call `onLaunch()` with the earlier `running` view. That stale view overwrote the service's confirmed `stopped` state, so the next start was rejected even though the child had exited.

## Fix

Added a generation fence to the runtime feed. Starting or stopping advances the generation, and every asynchronous console/status result checks the generation before forwarding output or lifecycle state. Added a regression test covering a status response that resolves after stop.

## Validation

Focused runtime feed, Launcher service, and shutdown tests pass with 62 tests. Full regression passes with 164 files and 1,435 tests. Type-check, Electron build, visual smoke, changed-file formatting, and diff validation pass. The Go networking unit/core packages pass; integration tests that require explicit `DSHKER_SERVER_BINARY` or `DSHKER_TEST_HARNESS_ROOT` remain environment-gated.
