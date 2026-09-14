# Task 4.2, final step — the shell switches to the core's checkout layer

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 4.2)

## What landed

The shell no longer owns any part of Harness checkout management. It asks the
core for one operation and keeps what the core answers with:

- `electron/main/core/checkout.ts` is the port — `gitRegister`,
  `repositoryInspect`, `prepare`, `verify` — beside `CoreInstallCatalog`, over
  the same private channel, with the same answer-shape checks.
- `ManagedInstallationService` calls it from all six flows: toolchain
  registration, the packaged seed, a clone, a revision switch, start, and the
  read-only repository inspection the workspace panel uses. The service keeps its
  own orchestration — capability consumption, catalog composition, state
  projection, runtime start and stop — and delegates every git decision.
- The shell's implementation is gone: `command.ts`, `inspection.ts`,
  `mirror.ts`, `paths.ts`, `process.ts`, `worktree.ts` and their four test
  files. What remains under `managed/git/` is only what a document validator
  needs — the error class, the remote and revision rules, and the record types —
  because `installation-catalog.ts` still validates the catalog it reads and the
  answer it receives with the same rules it always used.
- `electron/main.ts` builds the port from the core supervisor and hands it to the
  service; a shell without a core refuses these operations as
  `managed.core_unavailable` rather than falling back to running git itself.

Two rules moved _into_ the core rather than being dropped with the shell: the
mutable-reference rewrite check (`previousObservation` travels with a prepare
request) and the "verify the worktree if it is already there, materialize it if it
is not" behaviour a revision switch needs.

## One bug the port caught

The rewrite rule in `revision.ts` is **not** "the branch commit changed". It is a
`git merge-base --is-ancestor` check: a branch that moved forward is fine, and
only one that no longer descends from the commit it was observed at is a rewrite.
The first draft of the Go port compared the commits, which would have refused
every legitimate fast-forward. `AssertReferenceNotRewritten` now runs the
ancestry predicate for a branch and compares the commit for a tag, exactly as the
shell did.

## Evidence

- Shell: `npm run type-check`, `npm run architecture:check` and
  `npx vitest --run` — 153 files, 1279 tests, all green (the four deleted git-layer
  test files and their 13 cases are the only tests that left).
- Core: `gofmt`, `go build`, `go vet` and `go test ./internal/... ./cmd/...` — all
  green, including the checkout methods, the resolver and the rewrite rule.
- The Windows leg and CI run once for this landing, as agreed.
