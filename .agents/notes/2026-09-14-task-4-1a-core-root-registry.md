# Task 4.1, core side: the core owns the managed-root registry

Date: 2026-09-14

## What landed

`internal/rootregistry` is the Go owner of the document
`electron/main/managed/registry.ts` and `validation.ts` already wrote:
`dsh-launcher.managed-root-registry` version 2, at exactly
`managed-root-registry.json` below the Settings root.

The rules are ported rather than reinterpreted, because a registry either side
produced has to stay readable by the other while ownership moves: exactly four
roots with unique ids and kinds, canonical absolute paths that are not a
filesystem root, nothing naming a Harness `.dsh` directory, nothing overlapping
the existing Harness home, workspaces that bind every registered root once with
portable namespaces, no nested namespace ownership below one root, and no
duplicate or overlapping workspace directories.

`core.roots_inspect` and `core.roots_commit` are published in the version 1
table and answered. Both take the registry file path and the machine's Harness
home explicitly: the core owns one file name below the Settings root and refuses
any other path, rather than inferring where a caller's state lives. The store
validates the whole topology before it touches the disk, publishes through a
beside-the-target temporary file with an fsync, refuses a symlinked registry on
the way in as well as out, and proves the published bytes by reading them back.

## Two things this caught

- **The refusal families had to widen first.** The registry refuses with
  `managed.*` codes, which the renderer already maps to its own messages. Making
  the core report them would have collapsed every one to `p2p.operation_failed`,
  because `protocol.Refusal` accepted only `p2p.*`. It now accepts the declared
  families — `p2p`, `managed`, `launcher` — and still collapses anything else, so a
  library's internal error string cannot masquerade as a code. This is the same
  defect 3.8 fixed, caught this time before it shipped.
- **The encoder is pinned byte-for-byte.** `JSON.stringify(registry, null, 2)`
  plus a newline, with HTML escaping off — Go's default would have written
  `\u0026` where the shell writes `&`, so a display name containing one would
  have changed the file on every handoff. `TestEncodeMatchesTheShellBytes` holds
  the golden bytes and also parses them back.

## Verification

- `internal/rootregistry`: 11 test functions, 27 cases, mirroring the shell's own suite —
  the atomic round trip, a missing registry, any other file name or location, a
  symlinked registry, unknown and missing fields, an unsupported version, nested
  and bare roots, non-canonical paths, `.dsh` paths, an ancestor of the Harness
  home, every rejected namespace, nested namespaces, duplicate display names and
  overlapping working directories, plus the byte golden.
- `internal/core/server_roots_test.go`: the adapter round trip, the `managed.*`
  codes crossing unchanged, a refused commit leaving nothing behind, and
  malformed payloads.
- `integration/TestCoreDaemonOwnsTheRootRegistry`: the **real daemon** over the
  real private channel — `managed.missing_registry` before anything exists, a
  commit that publishes bytes this implementation parses back, an inspect that
  returns the same document, and refusals `managed.root_overlap` and
  `managed.unsupported_version` that change nothing.
- `internal/protocol`: the family rule is covered by 25 table cases plus the
  wrapped-sentinel case, including the new `managed.` and `launcher.` families and
  three ways of not being one.

## What Windows caught

Two of the layout cases were written with posix path literals (`/managed/harness`),
which are not absolute on Windows, so they asserted the wrong refusal there:
`managed.root_path_invalid` instead of `managed.root_overlap` or
`managed.dsh_runtime_overlap`. The implementation was right and the tests were
wrong. Both now build their paths from a temporary directory, so they validate the
platform's own spelling — including the filesystem root, which is `/` on Unix and
a bare volume root on Windows. The daemon round trip passed on Windows from the start, which is
what made the distinction clear.

## Deliberate fidelity note

The display-name uniqueness check compares the lower-cased label as written. The
shell also applied NFKC, which folds compatibility characters; matching that in
Go would add a Unicode tables dependency to a leaf package for a cosmetic
duplicate, so the difference is recorded rather than hidden.

## Platform evidence

- macOS: `go build`, `go vet` (native and `GOOS=windows`), every unit package, and
  the full `integration` suite (267 s). `format:check`, `architecture:check` and
  the unit suite (154 files, 1274 tests) pass; the shell is untouched this round.
- Windows (Go 1.26.4): `go build`, `go vet`, every unit package with `-count=1`
  including the new `internal/rootregistry`, and all six `TestCoreDaemon*` cases —
  the root-registry round trip among them.

## Outstanding

4.1b: route `ManagedWorkspaceService` through the two methods, delete
`ManagedRootRegistryStore`, and port `registry.test.ts`. The shell keeps its
candidate validation while it proposes a registry, and the core validates again
on commit — which is what makes the shell's copy disposable rather than
authoritative.
