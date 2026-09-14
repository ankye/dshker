# Tasks 7.3 and 7.4 — OpenSpec alignment

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, tasks 7.3 and 7.4)

## What the active changes say now

The three earlier changes are the ones whose deltas still described a shell that
owns subprocesses, credentials, and the remote route. Their normative text and
design decisions now name the trusted core, with the shell as the typed proxy:

- `add-managed-harness-desktop-shell`, `harness-runtime-supervision`: the core
  spawns and supervises the child (process group on POSIX, tree termination on
  Windows, bounded console exposed by cursor, readiness read from complete lines
  only), and the shell passes verified paths, packaged pnpm facts and the selected
  worktree in the launch request. Its design no longer says Electron main owns
  child processes; it says the shell keeps the window, native dialogs, the guest
  surface and the typed API, and proxies to the core.
- `add-self-hosted-p2p-dsh-connections`: the design said the Electron main
  process keeps local DSH ownership and encrypts credentials with `safeStorage`.
  Both now name the core and its platform stores, with a pointer to the rounds
  that moved them. The historical progress notes in its tasks keep their original
  wording and gained one sentence each recording where the ownership went, because
  rewriting a record of what was true then would be worse than annotating it.
- `add-managed-remote-dsh-connections`: its requirement **already** named the
  trusted core; only its design still said Electron main owns child processes and
  credentials and runs the OpenSSH connect sequence. Both sentences now name the
  core, and the design states that until the port lands the shell hosts the
  connector behind the same typed boundary rather than becoming a second
  implementation.

`openspec/config.yaml` needed no change: its context already says "The trusted
core owns Git, filesystem, subprocess, and secret storage; the Electron shell owns
the window, native dialogs, the guest surface, and the renderer-facing typed API,
and proxies named operations to the core." That is task 7.4's requirement, and it
was verified rather than assumed: every active change's spec and design was read
for a contradicting ownership claim, the four found were amended, and the
baseline `openspec/specs/` directory is empty, so nothing below the changes can
contradict it.

## Evidence

- `openspec validate <change> --strict` passes for all four active changes
  (`add-managed-harness-desktop-shell`, `add-self-hosted-p2p-dsh-connections`,
  `add-managed-remote-dsh-connections`, `go-owned-headless-core`).
- The stale quote in `go-owned-headless-core/design.md` that described the remote
  requirement as still assigning the route to Electron main was corrected to the
  wording that requirement actually has.
- `grep` over the active change set for `Electron main`/`主进程` followed by
  spawn, child, credential, secret or SSH ownership returns only two kinds of
  remaining hits: the shell's own renderer-authority rules (which are correctly
  the shell's) and the historical task records annotated above.

## What alignment does not claim

These edits align documents with the target boundary; they do not move code.
`electron/main/remote` still hosts the SSH route, and the managed-installation
runtime path still spawns its own child. Both are named in tasks 5.1 to 5.3 and
4.3 for the rounds that port them.
