# Task 5.3, shell half — the remote route moves behind the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 5.3)

## What changed

`RemoteConnectionService` no longer resolves OpenSSH, transfers a descriptor,
runs port forwards or writes the catalog. It is a typed proxy over the core's
`remote.catalog_inspect/create/update/remove`, `remote.connect/disconnect/status`
and `remote.broker_start/stop`, plus the renderer's own view state (which row is
connecting, which test passed, which edit is in flight). The page keeps the exact
shape it renders today.

Deleted outright, with their tests: `remote/catalog.ts` (406 lines),
`remote/openssh.ts` (447), `remote/peer-broker.ts` (244), and the suite that
covered them. What remains in `electron/main/remote/` is the proxy itself —
`service.ts`, `errors.ts` and the module index — about 370 lines instead of
about 1,800. No shell file spawns `ssh`, holds a descriptor, opens a listening
socket or writes the connection document any more; `grep` for those now finds
only the proxy's own imports.

The peer endpoint a remote machine reaches moved with it: `main.ts` asks
`remote.broker_start` for `<launcherRoot>/remote-peer.json` and the launcher's own
runtime subject, so the broker hands out the session this shell is running. Its
lifecycle is the core's now (the core's holder stops it on exit), and the shell's
shutdown owner is a thin `stopBroker` call.

## Two decisions worth recording

1. **The "no live generation" refusal had to be a code the renderer already
   names.** The core first reported `remote.not_connected` for a disconnect with
   nothing to stop. The renderer maps every member of
   `RemoteConnectionErrorCode` to a localized message, so a new code is a
   renderer change — exactly what 7.2 forbids. The core now reports
   `remote.connection_not_found` for that case, which the union already carries
   and which the page reads as "no such remote connection": accurate, and no
   renderer edit.
2. **The service resolves the catalog path per call.** The Settings root is not
   known when the service is constructed (the core starts later, and the locator
   may not exist yet), so the constructor takes a resolver and a getter for the
   core port — the same shape the launcher harness, the roots store and the
   installation catalog already use. A shell without a core refuses every remote
   operation with `remote.persistence_failed` rather than reaching for a second
   implementation.

## Evidence

- `electron/main/remote/service.test.ts` (6 cases) drives the proxy against a fake
  core port: a restored row is disconnected and untested, `connect` publishes
  ready from the core's answer, `test` opens and closes a generation and stays
  disconnected, a failure keeps a failed row with its code, a second connect while
  one is in flight is `remote.connection_busy`, removal of a failed row is
  `remote.connection_not_disconnected`, and a shell with no core refuses.
- The whole shell suite passes: 154 files, 1282 tests (four files fewer than
  before, because their subject no longer exists), plus type-check, format and the
  architecture gate.
- `internal/remoteroute` and `internal/core` still pass with the code change to
  `ErrNotConnected`, and the integration case that asserted the old string was
  updated with it.

## What is left of 5.3

Nothing structural: the catalog, the connector and the broker are the core's, the
shell is a proxy, and no shell file references the deleted modules. The remaining
work in P4 is elsewhere (the managed-installation runtime path and the shell
reduction in 7.1), and the packaged end-to-end pass in 7.5 is where the whole
route should be exercised again on both platforms.
