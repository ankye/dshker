# Task 4.2a — the installation catalog moves into the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P3, task 4.2, first half)

## What moved

`electron/main/managed/installation-catalog.ts` owned
`<settings root>/dsh-launcher/managed-installation-catalog.json`: the toolchain
registrations (Git, Node, pnpm with their fingerprints and versions) and the
managed Harness installations (remote identity, selection, commit, observed
reference and object). `internal/installcatalog` now owns the same document with
the rules ported rather than reinterpreted, and `core.install_catalog_inspect` /
`core.install_catalog_commit` are published and answered.

## Rules ported verbatim

- `format` `dsh-launcher.managed-installation-catalog`, `version` 3, and only the
  file name `managed-installation-catalog.json` — `Open` refuses any other path,
  so the location is not a caller's choice.
- Strict exact-key decoding at every depth: a catalog, a toolchain, a
  fingerprint, a version, a launcher, a remote source, a remote identity and an
  installation each refuse an unknown field. The shell's parser did the same, and
  the point is that a field this build does not understand is never silently
  dropped on a rewrite.
- Canonical absolute executable paths, four-component Git fingerprints with
  `modifiedAtMilliseconds`, six-component toolchain fingerprints, dotted
  three-part versions whose `text` must agree with the components, and a
  `node-script` pnpm launcher whose Node registration must be the toolchain's own.
- Remote identity is parsed, not trusted: transport, host, effective port,
  absolute-versus-relative path and display, with passwords, user names on
  `https`, queries, spaces and ambiguous segments refused. The declared URL must
  still re-parse to the recorded identity, which is what keeps a hand-edited file
  from claiming a repository it does not point at.
- Branch selections refuse a traversal, a leading `refs/` and a stray tag object;
  tag selections require the tag object and a 40-character commit.

## Two deliberate findings

1. **The two version refusals are asymmetric on purpose, and each matches the
   shell it replaces.** A *commit* whose `format` or `version` is not this build's
   is `managed.invalid_record`, because that is exactly what the shell's own
   `validateManagedInstallationCatalog` — the function its `save` called — threw.
   *Reading* a file another Launcher version wrote is `managed.unsupported_version`,
   because that is what its `parseManagedInstallationCatalog` threw on `load`.
   Collapsing the two would either make the writer accept a document it cannot
   read back or report a recoverable version difference as corruption.
2. **The byte golden lives in `testdata/` and is read by two packages.** The
   document was captured from the shell's own encoder and is asserted twice: the
   `installcatalog` test parses it and re-encodes it to the identical bytes, and
   the core and integration tests read the same file through the daemon. A second
   copy of the fixture would have let the two drift, which is the failure this
   golden exists to catch.

## Evidence

- `internal/installcatalog`: 24 functions/cases — round trip through the store,
  missing file, wrong file name, symlink refusal on both read and write, unknown
  fields at seven depths, unsupported version, eleven broken-record cases,
  fourteen remote-identity cases, and the shell byte golden.
- `internal/core`: commit/inspect round trip, the `managed.*` codes crossing the
  channel unchanged, the missing-file and version paths, malformed payloads, and
  an inspect of the shell's own golden bytes.
- `integration/install_catalog_test.go`: the real `dshkerd` over the real private
  channel — a missing catalog is `managed.missing_registry`, a published catalog
  re-parses, a refused commit leaves the previous bytes untouched, and the daemon
  reads the shell's golden file.
- `go build ./...`, `go vet ./...`, `go test ./internal/... ./cmd/...` and the
  full `./integration/` suite (267 s) pass on macOS.
- `networking/docs/shell-core-protocol.md` §5, §6 and §9 state the methods, the
  two asymmetric version refusals and the `catalog` answer envelope.

## Carried forward

- 4.2b: the shell stops writing the file. `ManagedInstallationCatalogStore`
  becomes core-backed exactly as `ManagedRootRegistryStore` did in 4.1, and the
  Electron writer is deleted.
- 4.2c: the Git and checkout operations themselves (clone, register, activate,
  switch, dirty-state blocking) still run in Electron; the catalog only records
  their result. `git` must be added to the declared refusal families when the
  core starts performing them.
