# Tasks 4.3–4.5, shell half — the launcher path runs through the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P3, task 4.3 to 4.5, shell side)

## What changed

`LauncherHarnessService` no longer spawns anything. Its `start`, `stop`,
`shutdown`, `setPort` and port load all go through
`electron/main/core/harness-runtime.ts`, the client for the core's
`runtime.*` methods. The child, its process tree, its port and its log now
belong to the core, and the service keeps what only the shell can do: decide that
the active version is usable, hand over the packaged pnpm facts and the verbose
overlay, and render the record the core answers with.

The renderer contract is untouched. IPC still calls the same service methods and
still receives `LauncherHarnessState` and one push per console record; only the
process behind them moved.

Three things were deliberately removed rather than left as a second copy:

- `launcherWebStartArguments` and its test. The command is the core's to build
  now; keeping the shell's builder would have been a second definition of the
  exact argument order, which is the thing 4.3 asks to verify.
- The child observer, the log stream, the port preflight and the tree-kill calls.
  A shell that still did any of them would be a second writer for the same
  process.
- The service's own log writes. The core writes the launch log and truncates it
  per launch, exactly as the shell did, so the shell only appends the output of
  the plugin commands it still runs.

## Two extractions, both forced by the architecture gate

- `launcher-runtime-feed.ts` holds the poll loop: it drains the core's bounded
  console feed by cursor, narrows the stream names to the renderer's four, and
  reports every launch record. It exists because the service crossed the
  1000-line budget — and because a poller is not a service method.
- The service's port read is now tolerant: `getState` must render the log path,
  the console and the launch record **without** a core, so an unreachable core
  leaves the automatic default in place and the next launch refuses properly.
  Making that read fatal turned four existing state tests red, and they were
  right: a state read is not an operation.

## Evidence

- `electron/main/core/harness-runtime.test.ts` (6 cases): the exact request the
  core builds the command from, the console cursor page, the port document in
  both directions, an answer that is not a launch record, and a `runtime.*`
  refusal crossing unchanged.
- `electron/main/managed/launcher-runtime-feed.test.ts` (5 cases): forwarding
  console records and the launch record, resuming from the cursor the core
  reported, stopping on a launch that ended, treating a subject the core no
  longer knows as stopped, swallowing an unreachable core, and narrowing the
  stream names.
- The full shell suite is green: 158 files, 1298 tests, plus type-check, format
  and the architecture gate (including its 1000-line budget).
- The local packaged smoke passes with the new wiring, which is the check that
  the shell still boots and paints when its runtime lives somewhere else.

## Still to do

- `ManagedHarnessWebRuntimeSupervisor` (the managed-installation path) still
  spawns its own child with `node apps/cli/lib/bin.js web --no-open`. It has the
  same shape as the launcher path and can be switched the same way: keep the
  class and its interface, cache the core's launch record per installation so the
  synchronous `launchFor` projection keeps working, and poll for console output.
- Nothing yet proves a real `dsh web` launch end to end from the shell, because
  that needs a built Harness checkout. The Go integration test drives a real
  child through the real daemon, and the smoke proves the shell boots; a
  shell-driven launch belongs with the packaged end-to-end pass in P6.
