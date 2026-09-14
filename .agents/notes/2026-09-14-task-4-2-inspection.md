# Task 4.2, fourth slice — read-only repository inspection

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 4.2)

## What landed

`inspection.go` and `command.go` in `internal/gitcheckout`, ported from
`electron/main/managed/git/inspection.ts` and `command.ts`:

- `InspectRepository` observes a user-owned checkout with read-only git commands
  only. It refuses a path that is not a canonical, non-symlink, non-root existing
  directory; it refuses a path whose `rev-parse --show-toplevel` is not the path
  the user selected (so selecting a subdirectory of a worktree is refused rather
  than silently inspected as its root); it requires
  `rev-parse --is-inside-work-tree` to answer `true`; it resolves HEAD as a
  commit and refuses anything that is not a full SHA; it requires the named remote
  to exist and to still be the identity that was confirmed; and it reports the
  working-tree entries.
- `command.go` carries the three readings a git answer needs:
  `RequireSingleGitLine` (exactly one non-empty line, or
  `git.ref_ambiguous`), `RequireGitReferenceCommand` (exit 1 and 128 mean the
  reference is unavailable, anything else is a command failure with the bounded
  observation attached) and `IsGitAncestryResult` (exit 0 true, exit 1 false,
  anything else an error rather than a false answer).

## One deliberate difference, and why it is safe

The shell issued the HEAD, remote and status observations together with
`Promise.all`, so a repository failing more than one of them reported whichever
rejected first in time — a diagnostic that could differ between two runs on the
same machine. This takes them in a fixed order: HEAD, then remote, then the
working tree. Each is still read exactly the same way, and the refusals are
unchanged; only the choice among several failures is now deterministic.

## Evidence

`inspection_test.go` uses real repositories, because inspection is a conversation
with git and a fixture that answers by hand would only prove the fixture:

- a real `git init` + commit + `origin` remote: the inspection returns the
  repository's own HEAD, the parsed identity of the confirmed remote, and no
  working-tree entries — and after an untracked file is added, exactly that file
  is reported;
- the same repository inspected against a different repository's URL
  (`git.remote_mismatch`) and against a remote name that is not configured
  (`git.remote_missing`);
- a nested directory inside a worktree, a plain directory that is not a
  repository, an empty path, a relative path, the filesystem root, a trailing
  separator and a symlinked path — each `git.repository_invalid`;
- the three command helpers: one line with and without CRLF, trailing blank lines
  accepted because git prints them, empty and two-line answers refused, and the
  three exit-status readings pinned by code.

Green on the host (`gofmt`, `build`, `vet`, `go test ./internal/... ./cmd/...`),
for `GOOS=windows` and `GOOS=linux`, and on the Windows machine.

## What remains in 4.2

The mirror and its verification (`mirror.ts`), worktrees and the dirty-state block
(`worktree.ts`), and then the switch: pointing `ManagedInstallationService` at the
core and deleting `electron/main/managed/git/`.
