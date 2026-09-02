# Managed DSH uses one reclaimable process tree

## Context

The Launcher started `pnpm dsh -- web --no-open` as one child but only sent `SIGTERM` to the pnpm wrapper. It also had no Electron quit or signal hook. Closing or restarting the shell could therefore leave the Node DSH server orphaned, holding its loopback port while a later Launcher process believed no runtime existed. `stop()` returned before the listener had actually exited, so a version mutation could race the old server.

## Decision

On POSIX the Launcher starts pnpm as a detached process group and sends `SIGTERM` to that group. Windows retains the direct-child signal path because Node does not expose the POSIX negative-pid group form there. The service waits for root-child exit with an explicit shutdown deadline before it reports stopped. Electron normal quit and `SIGINT` or `SIGTERM` call the same service shutdown method; a failed termination leaves the app alive instead of abandoning its child.

## Consequences

An explicit stop now proves the previous DSH tree has relinquished its port before a branch or commit can be selected. A normal Launcher shutdown no longer abandons a pnpm/Node tree. Forceful termination that bypasses Electron and process signals remains an operating-system interruption, so a later start preserves an unproven listener and reports DSH's explicit port-in-use failure rather than killing it.

## Evidence

`npm test -- --run electron/main/managed/process-tree.test.ts electron/main/managed/launcher-harness-service.test.ts electron/main/managed/launch-log.test.ts` passed with 43 tests. `npm run type-check` passed.
