# Task 4.3, second half — the managed installation's child is the core's

Date: 2026-09-14
Change: `go-owned-headless-core` (P4, tasks 4.3, 4.4, 4.5)

## What changed

The Launcher's own DSH Web child moved into the core in the first half of 4.3.
The other child did not: `ManagedHarnessWebRuntimeSupervisor` still spawned
`node apps/cli/lib/bin.js web --no-open` itself for every managed installation.
It does not any more. The core now has two named command profiles, and the shell
asks for the second one:

- `pnpm` — the Launcher's own profile, unchanged: `pnpm dsh web --patch <overlay>
--no-open [--port <port>]` from the active version directory.
- `node` — one managed installation: `node apps/cli/lib/bin.js web --no-open
[--port <port>]`, run from that installation's worktree with no PATH override
  and no pnpm facts at all.

The entry is named exactly as the shell named it — `apps/cli/lib/bin.js`,
relative to the launch directory the core sets as the child's working directory —
so the constructed command is the current command, byte for byte. The port is
optional for this profile in the same way it is for the other one: the shell's
managed path holds no port preference, so it asks for automatic and no `--port`
appears; a fixed selection appends it between the profile's arguments.

The shell keeps what it still owns — which installation, which worktree, which
resolved revision, and the identity of the Node it pinned — and gives up
everything else: the spawner and its environment, the `lstat`/`realpath` check of
the built entry, the stdout/stderr byte accounting and truncation flags, and the
`exit`/`error` listeners that decided whether a launch had stopped, failed or
crashed. `harness-web-runtime.ts` is 200 lines of typed proxy instead of a
process owner, and its spawner seam is gone.

## Three decisions worth recording

1. **The built entry is verified by the core, and the directory is resolved
   first.** The shell's rule was `realpath(entry) === entry`; applied literally in
   Go it refused every checkout under a symlinked directory, which is what
   `t.TempDir()` is on macOS (`/var` → `/private/var`). What must be direct is the
   entry, not the path that reaches it, so the directory is resolved and the entry
   is then required to be a regular file that is not itself a link and resolves to
   itself. A missing, indirect or replaced entry is `runtime.worktree_invalid`
   before anything spawns.
2. **Launch state is read from the core, not cached.** `launchFor` used to answer
   from a map the exit listeners kept current. It now asks `runtime.status`, so a
   child that exited while no one was looking is stopped or failed the moment the
   state is projected — the same guarantee, from the authority that owns the
   child. The projection of a whole catalog reads every installation at once, and
   the guard that refuses a revision switch while a child is active became
   asynchronous so it can ask the core rather than trust a stale map. The map is
   still kept, but only as the shell's memory of the facts the core does not
   carry (worktree and revision).
3. **Both new request fields are required on the wire.** The private channel
   decodes strictly — a declared field that is absent is `p2p.missing_field`, never
   a default — so `profile` and `nodeExecutable` are sent by every caller, empty
   where they do not apply, and an unknown profile is refused rather than treated
   as the pnpm one.

## Evidence

- `internal/harnessruntime`: the command for a managed installation is pinned
  with and without a fixed port; the entry refusals cover missing, directory and
  symlinked entries; the profile admission covers a relative Node path, a foreign
  profile and a relative directory.
- `internal/core`: the managed profile over the real private channel — a missing
  entry is refused with `runtime.worktree_invalid`, a real child starts, announces
  `http://127.0.0.1:3098/?token=managed`, reports running and stops. The
  spawn-level case is skipped on Windows because the stand-in entry is a shell
  script; the _constructed_ command is pinned by the package test, which is
  platform-agnostic and runs there.
- `electron/main/managed/harness-web-runtime.test.ts`: four cases — the request a
  managed start sends (profile, Node, worktree, subject), `launchFor` answering
  from the core and refusing an unknown installation, a shell with no core
  refusing to supervise, and a core refusal leaving no running installation
  recorded.
- `electron/main/core/harness-runtime.test.ts` carries both profiles, and the
  launcher's own request names `pnpm` explicitly.
- Green: `gofmt`, `go build`, `go vet` for the host and for `GOOS=windows`, the
  whole Go unit suite, the shell's `type-check`, `format:check`,
  `architecture:check` and the 33 managed/core test files (231 tests).
