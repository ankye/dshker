# Task 4.2, first slice — the checkout rules that guard git

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, task 4.2)

## What landed

`networking/internal/gitcheckout` is the first piece of the checkout layer the
core now owns, ported from `electron/main/managed/git/`:

- `remote.go` — the remote rules (`remote.ts`): what a remote URL may be, what a
  remote name may be, which transport identity a URL has, and when two remotes
  are the same repository. HTTPS and SSH only; no credentials, no URL extras, no
  percent escapes, no local path, no `ext::` helper, no dot segment; scp-form
  `[user@]host:path` is accepted and keeps its two spellings.
- `revision.go` — the selection rules (`revision.ts`): a full lowercase SHA and
  nothing shorter, git's own short-name rules for branches and tags, and a
  selection record that cannot carry two kinds at once.
- `translate.go` — the boundary rule (see below).

These first because everything else in the layer hands its values to git through
them: a mirror is only ever cloned from a parsed source, a worktree is only ever
created at a resolved commit. They are also pure — no filesystem, no process — so
they could be ported exactly and verified completely before the runner exists.

## The boundary decision

The git layer's own codes (`git.remote_invalid`, `git.ref_invalid`,
`git.repository_dirty` …) are **not** in `protocol.RefusalFamilies`, and they must
not be: the page never sees them. The shell translates them today in two places —
`managed.git_remote_invalid` when a remote is refused,
`managed.git_revision_invalid` when a selection is, and
`managed.git_operation_failed` for everything deeper. `RendererCode` carries
that same translation into the core, so the codes that cross the private channel
are the three the renderer already maps and no contract changes. Adding a `git`
family would have been the smaller edit and the wrong one: it would put internal
vocabulary on the page's union.

## Two porting details worth recording

1. **The JavaScript URL parser keeps the brackets around an IPv6 literal; Go's
   `Hostname()` strips them.** `hostnameOf` puts them back, so
   `ssh://[::1]/srv/repo` hashes and displays as the shell's does. Without it the
   bracketed-literal rule could never match and every IPv6 remote would be
   refused.
2. **The character rule runs before parsing.** Whitespace, control characters, a
   backslash, `%`, `#` and `?` are refused on the raw string, which is what
   rejects credentials and URL extras before a parser can normalize anything
   away. `D:/repo` is therefore read the same way the shell reads it — scp form
   with host `d` — and it is the identity comparison, not the parser, that
   refuses it as the wrong remote.

## Evidence

- `remote_test.go`: nine accepted forms with their exact identities and displays
  (default and explicit ports, upper-case hosts, IPv4, IPv6, loopback, both scp
  spellings), twenty-six refused values, the remote-name rules, the persisted
  record's re-validation (an edited host, a dropped SSH user, an edited display
  and an invalid name are each refused), identity equality across spellings, and
  a mismatch that names both addresses.
- `revision_test.go`: the SHA rule, accepted and refused short names (including
  control characters, `\`, `~`, `^`, `:`, `*`, `[`, `.lock`, `..`, `@{`, a
  `refs/` prefix and the length bound), the selection record, and selection
  equality.
- `translate_test.go`: the three renderer codes and the default.
- Green: `gofmt`, `go build ./...`, `go vet ./...` for the host, for
  `GOOS=windows` and for `GOOS=linux`, and the whole Go unit suite.

## What remains in 4.2

The runner (`process.ts`: the pinned git executable and its fingerprint, the
closed environment, bounded output, timeouts, redaction), the managed layout and
escape rules (`paths.ts`), read-only repository inspection (`inspection.ts`), the
mirror and its verification (`mirror.ts`), worktrees and the dirty-state block
(`worktree.ts`), and then the switch itself — pointing
`ManagedInstallationService` at the core and deleting
`electron/main/managed/git/`. Until that switch, this package has no caller in
production, which is the same order 4.1 and 5.3 were landed in.
