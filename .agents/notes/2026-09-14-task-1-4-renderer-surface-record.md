# Tasks 1.4, 2.4 and 7.2 — the renderer surface, recorded and checked

Date: 2026-09-14
Change: `go-owned-headless-core` (P1 and P6)

## The record (1.4)

`electron/preload-surface.golden.json` is the renderer-visible surface as main
actually exposes it: `apiVersion` and 88 named operations, each written as the
dotted path the renderer calls (`launcherHarness.start()`,
`p2pManagement.acceptInvite()`, and so on). It is produced from the production
preload through the mocked `electron` bridge — not from the type declaration —
because a type can be satisfied while the object gains or loses a member, and it
is the object the renderer holds.

`electron/preload-surface.test.ts` pins it in both directions: it fails when an
operation is added or removed, and it refuses a surface that carries an invoker,
a channel name or raw `ipcRenderer` access. Re-record it with
`PRELOAD_SURFACE_UPDATE=1 npx vitest --run electron/preload-surface.test.ts`, which is
the one deliberate act that changes the promise.

## The typed proxy layer (2.4)

The proxies exist now, and this is the mapping they keep. Every one of them is a
typed client in `electron/main/core/` reached only by main over the private
channel; the shell services above them translate errors and project the fields
the renderer already read.

| renderer group                   | core client                | core methods                                                                                                        |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `managed` (registry)             | `roots.ts`                 | `core.roots_inspect`, `core.roots_commit`                                                                           |
| `managedInstallations` (catalog) | `install-catalog.ts`       | `core.install_catalog_inspect`, `core.install_catalog_commit`                                                       |
| device catalog and credentials   | `catalog.ts`, `secrets.ts` | `core.catalog_inspect/_enable/_commit/_remove_service`, `core.secret_get/_set/_delete`                              |
| `launcherHarness`                | `harness-runtime.ts`       | `runtime.start`, `runtime.stop`, `runtime.status`, `runtime.console`, `runtime.port_get`, `runtime.port_set`        |
| `remoteConnections`              | `remote-route.ts`          | `remote.catalog_inspect/_create/_update/_remove`, `remote.connect/_disconnect/_status`, `remote.broker_start/_stop` |

The verification 2.4 asked for is that no renderer or preload file has to change
for this: neither `electron/preload.ts` nor `electron/workbench-preload.ts` was
touched by any commit of the change, and the surface record below is the same
list of operations before and after.

## The surface at the end (7.2)

- `git log <first-change-commit>..HEAD -- electron/preload.ts electron/workbench-preload.ts`
  is **empty**: the frozen bridge is byte-for-byte the one the change started with.
- The surface record equals it: 88 operations, `apiVersion` 1, asserted by the
  test rather than by reading the file.
- Two things under `src/` did change inside the same time window, and neither was
  required by this change: `f71adeb` added one member to
  `ManagedOperationErrorCode` (`managed.core_unavailable`, the code a shell with
  no core now reports, which 4.1's own task needed), and `fd6ef7e`/`84f475f` are an
  unrelated tab-behaviour fix and a style commit. A type union gaining a member
  is not a new operation on the bridge, and the renderer tests that cover it pass
  unchanged.

## Evidence

- `electron/preload-surface.test.ts`: the recorded surface, and the "no invoker is
  exposed" property.
- The shell suite passes with the record in place, and the architecture gate
  still reports no boundary violation.
