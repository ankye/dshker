# Task 3.6a: the core owns the device catalog

Date: 2026-09-14

## What landed

`networking/internal/catalog` reads and writes the same files the shell's
`catalog.ts` writes: `p2p-devices.json` plus the `p2p-enabled.json` marker.

- `record.go` — the record types plus a strict parser. It refuses unknown fields,
  a wrong format or version, malformed ids, a service whose key does not hash to
  its id, a certificate that is not this key's self-signed CA, endpoint shapes
  that are not exactly what the shell accepts, a computer pointing at an absent
  service, and any duplicate id.
- `store.go` — `Open`, `Inspect`, `Enable`, `Commit`, `RemoveService`. The
  revision is the sha256 of the file's bytes, exactly as the shell computes it,
  so the two implementations agree on what "unchanged" means. A first enable
  writes a marker beside the record; either file alone is corruption, never an
  implicit reset. Publishing writes a complete file and only then makes it
  visible, moving an existing record aside on Windows where a rename cannot
  replace it.
- `transition.go` — `AssertTransition`, the port of `catalog-transition.ts`.

## The rule that surprised the tests

Writing the tests surfaced a real ordering requirement. `AssertTransition`
compares against the **previous** forgotten set, so a single write that both
forgets a service and removes it is refused with `forget_required`: forgetting
has to be in the previous state before the record may drop the service.
`RemoveService` exists precisely because the shell's `removeService` does both at
once — it is the sanctioned path, and it deliberately bypasses the transition
check while still re-validating what it writes, so the file can never become
unreadable. The tests now assert both halves: the one-step write is refused, and
the two-step sequence is accepted.

## Verification

53 test cases, including one that pins the JSON field names against what
`catalog.ts` writes — a rename on either side would silently split the two
implementations, and only a field-level check catches that.

- macOS: `go test ./internal/catalog/` green, `-race` clean, and the whole
  repository green including integration (261s).
- Windows: build, vet and the catalog tests pass.

## What this does not do

Nothing in production reads this package yet: the shell still owns the catalog
through `PeerCatalog`. Committing it now, on a tested baseline, is what makes
3.6b a routing change rather than a rewrite.
