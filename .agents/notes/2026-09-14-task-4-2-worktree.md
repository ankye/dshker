# Task 4.2, sixth slice — the managed worktree and the dirty-state block

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 4.2)

## What landed

`worktree.go` in `internal/gitcheckout`, ported from
`electron/main/managed/git/worktree.ts` — the last piece of the checkout layer
that lived only in the shell:

- **`MaterializeWorktree`** creates one detached worktree for an exact resolved
  commit, under the installation lock, and only after the mirror has been
  re-verified: a mirror that no longer fetches from the confirmed URL must not be
  built on. The worktree's path _is_ the commit, so a worktree can only ever exist
  for the commit it was created from, and an existing one is
  `git.worktree_exists` rather than reused.
- **`VerifyWorktree`** re-reads every runtime-relevant identity without changing
  the checkout: the top level is the registered path, HEAD is the selected commit,
  `--git-common-dir` resolves to _this_ installation's mirror (so a worktree
  cannot be borrowed from another one), the remote is still the confirmed
  identity, and the working tree is clean.
- **`AssertWorktreeClean`** is the dirty-state block: the full porcelain status
  with untracked files included, and any entry at all refuses activation as
  `git.repository_dirty` with the count and the first entry named. A user's
  uncommitted work is never something the launcher may switch away from.

## Evidence

`worktree_test.go`, with real repositories, real bundles, real mirrors and real
worktrees:

- a worktree materialized for a commit is detached (`--abbrev-ref HEAD` is
  `HEAD`), its HEAD is that commit, and it verifies; the second commit gets its
  own worktree, which is clean;
- a second materialization of the same commit is `git.worktree_exists`;
- an empty, abbreviated, upper-case or expression-shaped commit is
  `git.ref_invalid`; a well-formed SHA the mirror does not contain is a git
  failure (`git.command_failed`) rather than a launcher refusal, because the
  mirror was asked and answered; materializing without a mirror is
  `git.managed_path_invalid`;
- a worktree whose HEAD was moved to another commit with `git checkout --detach`
  is `git.worktree_mismatch`;
- a modified tracked file and an untracked file are each `git.repository_dirty`,
  and the worktree verifies again once it is clean.

Green on the host (`gofmt`, `build`, `vet`, `go test ./internal/... ./cmd/...`),
for `GOOS=windows` and `GOOS=linux`, and on the Windows machine.

## What remains in 4.2

The core now owns the whole checkout layer. What is left is the switch itself:
pointing `ManagedInstallationService` at the core — publishing the checkout
operations over the private channel with the renderer codes the page already maps
— and deleting `electron/main/managed/git/`.
