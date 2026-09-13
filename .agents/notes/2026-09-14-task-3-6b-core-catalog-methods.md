# Task 3.6b, core side: the core serves the device catalog

Date: 2026-09-14

## What landed

Four methods are now published in the version 1 table and answered by the core:
`core.catalog_inspect`, `core.catalog_enable`, `core.catalog_commit` and
`core.catalog_remove_service`. They are additive, which the table allows: an
older shell simply never calls them and an older core refuses them with
`p2p.not_implemented`.

The design decision this needed was how the catalog's directory reaches a
process that no longer shares the shell's settings root. `dshkerd` now takes
`--catalog <absolute directory>` beside `--data`, in any order, and opens the
store at boot — so a wrong path fails the boot instead of the first call that
needs it. The directory must already exist, which it does: it is the shell's
settings root, the same one the credential store is rooted at.

The answer reuses the record's own wire shape, so the shell parses it with the
validator it used while it still owned the file, and the revision is still the
sha256 of the stored bytes. `core.catalog_inspect` answers `{"enabled":false}`
for a directory that was never enabled, and a core started without a catalog
directory refuses these methods rather than reporting an empty catalog, which
the shell would render as "everything was forgotten".

## Deliberately not done yet

Nothing routes to it. `PeerCatalog` in the shell still reads and writes the file
itself, so there are two implementations of the same format and only one of them
is in use. The switch-over, the one-shot migration of an existing file and the
removal of the shell's writers are the rest of 3.6b; splitting it this way keeps a
tested core half from being entangled with a shell change that touches the
packaged app.

## Verification

- `internal/core`: 7 new tests cover the adapter — never-enabled inspect, enable
  then inspect, the revision carried through a commit and a stale one refused,
  an absent service, every method refused without a store, malformed payloads,
  and the published table. The catalog's own validation stays covered by the 53
  tests from 3.6a rather than duplicated here.
- `cmd/dshkerd`: 16 cases over the argument parser, including both orders, a
  repeated flag, a relative value and a trailing flag.
- `integration`: the real daemon is now launched with `--catalog` and asked for
  `core.catalog_inspect` (not enabled) and `core.catalog_enable` (enabled, with a
  catalog id) over the authenticated private channel.
- macOS: full suite green including integration (261s). Windows: build, vet, the
  four unit packages and the daemon process tests all pass.
- `networking/docs/shell-core-protocol.md` updated: the `core` row was already
  stale (it predated the secret methods), and the catalog's revision and
  never-enabled semantics are now stated there.
