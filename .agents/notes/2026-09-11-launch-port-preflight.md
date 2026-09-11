# Launch-port preflight: adopt leftover DSH Web, refuse foreign holders

2026-09-11

## Defect

`start()` spawned DSH Web without ever checking whether the fixed launch port
was free. A leftover DSH Web process — one left by an interrupted manual
development launch from the workspace (`pnpm dsh web --port 3088`), or one a
crashed Launcher could no longer stop — held 127.0.0.1:3088 indefinitely. Every
later launch then died inside the DSH guest with `listen EADDRINUSE`, which
surfaced as `managed.harness_launch_failed` ("内核未启动"). Real-world incident:
a 13-hour-old workspace `pnpm dsh web` blocked packaged launches until the user
killed it by hand; the boot error mentioned only "plugin tree failed to load:
webserver ... EADDRINUSE".

## Fix (uncommitted commit in this round)

- `electron/main/managed/port-occupancy.ts` (new): port-holder detection and
  decision. POSIX uses `lsof -nP -iTCP:<port> -sTCP:LISTEN` then `ps -o
command=`; Windows uses `netstat -ano` then `wmic`. Pid parsing ignores
  headers and non-numeric fields; an unreadable command line still keeps the
  pid. `isResidualDshWebCommand` matches `dsh web` or `bin.(j|t)s web`.
  `terminatePortOccupant` SIGTERM, then poll, then SIGKILL, tolerating ESRCH.
  `preparePortForLaunch` returns free / cleared / foreign.
  `foreignPortFailure` builds the `runtime.port_in_use` typed error.
- `launcher-harness-service.ts`: `start()` preflight calls
  `#prepareLaunchPort()` (fixed mode only; auto mode needs no check). A
  recognized leftover is stopped and logged; a foreign holder throws
  `runtime.port_in_use` so the renderer explains "端口被其他程序占用" instead
  of "内核未启动".
- Error chain: `runtime.port_in_use` to `managed.harness_port_in_use` in
  `ipc-error-codes.ts` (plus enumerable list), `errors.ts`, `contracts.ts`,
  AppShell toast maps, zh/en copy `toast.error.harnessPortInUse`. The
  ipc-error-codes suite asserts every runtime code has an explicit mapping, so
  this cannot silently fall back to `harness_launch_failed` again.

## Boundaries kept

- Only `dsh web` / `bin.(j|t)s web` command lines are adopted; any other
  holder is refused, never killed. The Launcher must not stop programs it does
  not own.
- Auto port mode is skipped entirely.
- The ready/announced URL remains the only runtime-address source; the port
  preflight decides nothing about addresses.
- Service file stayed under the 1000-line budget (996) by giving
  `preparePortForLaunch` default deps instead of inlining the plumbing.

## Verification

- `port-occupancy.test.ts`: 18 cases (pid parsing both platforms, empty/header
  listings, residual recognition incl. negative cases, free/adopt/refuse
  decisions, SIGTERM-not-SIGKILL when gone, escalation when stubborn,
  already-gone tolerance, failure message content with/without command line).
- `ipc-error-codes.test.ts` holds the mapping; full suite 146 files / 1216
  tests pass; type-check, prettier, architecture check, vue-tsc green.

## Real-environment note

The offending 3088 instance was a manual workspace launch, not the packaged
one; the user cleaned both leftovers by hand before this landed. The 3080
workspace instance the user later started for development is untouched — it
is not the fixed launcher port and was left alone.

## Related

- 2026-09-10 plugin-update convergence (`a3c4350`): yet another "plain Error
  folded to launch failure" case fixed by typed errors. This round is the same
  lesson on the launch side: distinct causes must keep distinct codes.
