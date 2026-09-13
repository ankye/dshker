# Task 3.6b, shell side: the core owns the device catalog

Date: 2026-09-14

## What landed

`PeerCatalog` now runs every operation through the core when one is available:
`electron/main/core/catalog.ts` is the main-only client for
`core.catalog_inspect`, `core.catalog_enable`, `core.catalog_commit` and
`core.catalog_remove_service`, and `PeerCatalog` consults it first for
`inspect`, `enable`, `commit` and `removeService`. `CoreSupervisor` starts
`dshkerd` with `--catalog <settings root>/dsh-launcher` beside `--data`, and
`main.ts` wires `CoreCatalog` into `PeerManagement` exactly where `CoreSecrets`
already goes.

There is no copy step, and that is the point. The core is pointed at the very
directory the shell has always written `p2p-devices.json` and `p2p-enabled.json`
into, so an existing record is adopted in place: same file, same format, same
catalog id, and the same sha256-of-bytes revision the shell computed by hand one
release earlier. A previous install upgrades with nothing to migrate and nothing
to lose, and a build that starts no core at all still reads every byte the core
wrote — the two are never divergent writers, because only one of them ever
writes.

## Decisions

- **The refused calls that mean "this core has no catalog" degrade, and nothing
  else does.** `p2p.catalog_unavailable` (a core started without `--catalog`),
  `p2p.not_implemented` and `p2p.invalid_operation` (a core built before the
  methods existed) latch the shell onto its own file for the rest of the process.
  A transport failure deliberately does **not**: falling back while a core is
  alive but unreachable would recreate the second writer this exists to remove,
  so it propagates instead.
- **The record cap is now smaller than the frame cap.** A whole record crosses
  the private channel in one frame, and `localrpc` silently drops a frame larger
  than `protocol.MaxControlBytes`, which would leave the caller waiting out its
  90 s budget for a reply that can never arrive. `catalog.MaxRecordBytes` and
  `MAX_CATALOG_BYTES` are 60 KiB against the frame's 64 KiB, and
  `internal/core/catalog_frame_test.go` measures the envelope and fails if a
  record at the cap would no longer fit — reverting the cap to 64 KiB reproduces
  the failure (65709 bytes needed of 65536).
- **Identity continuity stays enforced on both sides.** The shell still validates
  a commit's record synchronously before queueing it, so a caller cannot mutate
  queued input, and the core re-validates and re-runs the transition rules, so a
  shell bug cannot replace a trusted key or drop a pair silently.

## Deliberately not done yet

`PeerCatalog`'s file path is retained as the degraded writer for a shell that
started without a usable core, mirroring how 3.5 kept `safeStorage`. It stops
being reachable when the core is mandatory in P6 (task 7.1), which is where the
remaining Electron writers go. The pending-enrollment and user-session records
(3.6c) and the connection state machine (3.6d) are untouched.

## Verification

- `electron/main/core/catalog.test.ts`: 10 cases over the client — a
  never-enabled answer, a projected record, a record that no longer validates,
  three malformed projections, enable, the commit payload, a refusal carried
  through, and a re-parse of what the client returns.
- `electron/main/p2p/catalog-core.test.ts`: 9 cases over the routing — the core
  wins and the file is left byte-identical, a never-enabled core is
  authoritative, each of the three unserved codes falls back exactly once, a
  transport failure propagates without writing, a commit is validated before the
  core sees it, all four operations route, and the local writer still works after
  the latch.
- `electron/main/core/catalog-core.test.ts`: 2 cases against the real `dshkerd`
  binary. A catalog written by the shell's own released writer is read back by
  the core itself with the identical revision and record; a revoke and a removal
  through the core land in that same file, are read back by the shell's local
  reader, keep the sha256 revision, and survive a core restart. The second case
  enables through the core, confirms the shell sees what the core published, and
  gets `p2p.catalog_exists` on a second enable.
- `electron/main/core/supervisor.test.ts`: 10 cases, now including the
  `--catalog` argv (with a directory the supervisor creates itself) and refusals
  for a non-directory and a relative catalog root.
- macOS: `npm run type-check`, `format:check`, `architecture:check` and the full
  unit suite (153 files, 1263 tests) pass; `go build`, `go vet` (native and
  `GOOS=windows`) and the Go suite including `integration` (262s) pass.
- Windows (real `dshkerd.exe`, cross-built at `build/p2p/win32-x64`): the full
  unit suite passes (152 files / 1251 tests, 1 file / 12 tests skipped) and
  `supervisor.test.ts` passes with `DSHKER_CORE_BINARY` pointed at the real
  binary. The new `catalog-core.test.ts` passes against that binary too, which
  is where the in-place adoption, the revoke/remove round trip and the core
  restart are proven on Windows. Every Go unit package, `cmd/dshkerd`, and 12 of
  the 14 `integration` tests pass in 262s. The two that do not are
  `TestManagerRealDSH` and `TestManagerNetworkRevocationRealDSH`, and they fail
  before reaching any of this change: both launch the harness's own `dsh web`,
  which exits immediately on that machine with
  `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-http-proxy` because its harness
  checkout has an incomplete `node_modules` ("real DSH exited before runtime
  announcement"). That is a harness-install gap on the test box, not a catalog
  regression, and it is recorded rather than papered over.
