# Tasks 4.3–4.5 — the DSH Web child moves into the core

Date: 2026-09-14
Change: `go-owned-headless-core` (P3, tasks 4.3, 4.4 and 4.5 — one unit of work)

## What moved

`electron/main/managed/{launcher-harness-service,port-occupancy,launch-preferences,
child-output-observer,process-tree,child-exit}.ts` built and supervised the
`dsh web` process inside Electron main. `internal/harnessruntime` does now, and
the core publishes `runtime.start`, `runtime.stop`, `runtime.status`,
`runtime.console`, `runtime.port_get` and `runtime.port_set`.

The command is the shell's own, argument for argument:
`pnpm dsh web --patch <overlay> --no-open`, with `--port <port>` only for an
explicit fixed selection, plus the shim's prefix arguments and the PATH its
subprocesses need, run from the active version directory. A shim that could not
be resolved refuses the launch instead of guessing.

## What the core now owns

- **The port.** A fixed port is prepared before anything spawns: a leftover DSH
  Web process is recognized with the shell's own rule (`\bdsh web\b` or
  `bin.js web`) and stopped, and any other holder is refused with
  `runtime.port_in_use` and its description. `launch-preferences.json` moved
  with it, byte-compatible and with the same 1024–65535 range and the same silent
  fall back to automatic for a record this build cannot use.
- **The tree.** The child is the leader of its own process group on Unix and is
  stopped through `taskkill /t` on Windows. The stop waits up to five seconds,
  escalates once, and then reports `runtime.shutdown_timeout` rather than
  claiming a stop it cannot observe.
- **The log.** A fresh `[launcher] … starting dsh web` line per launch, then the
  child's own output verbatim. The console feed is bounded at the shell's 1000
  entries and drained by cursor, which is the sequence the renderer already
  unions snapshots by, so the renderer contract is untouched.
- **The announcement.** `dsh web: <url>` is read from complete lines only and
  only for a loopback http(s) origin. A split line could otherwise adopt a
  truncated URL and drop the session credential DSH puts in its query; a log line
  quoting some other host could otherwise redirect the runtime view.

## Evidence

- `internal/harnessruntime`: 16 cases. The command matches the shell's argument
  list and forwards the shim; the port range and the preferences bytes match; the
  announced URL is accepted only for loopback and only from a complete line; the
  console keeps 1000 entries with a stable cursor; and the supervisor drives a
  real child end to end — announcement to `running`, log and console contents,
  the double-start refusal, a stop that leaves nothing behind, `Shutdown` over two
  children, and a Unix-only case where a **grandchild** is recorded by pid and
  must be gone after the stop.
- `internal/core`: 4 cases over the private channel — the preferences round trip,
  a privileged port refused, the whole lifecycle driven through `Handle`, the
  `p2p.not_implemented` refusal for a core with no process authority, and
  strictly decoded payloads.
- `integration/harness_runtime_test.go`: the real daemon. A subject that never ran
  answers `present:false` and `runtime.stop` refuses it with
  `runtime.not_found`; a start answers a pid; a second start is
  `runtime.operation_in_progress`; the child's announced URL and output cross the
  channel; and after the stop the pid is provably gone.
- `runtime.*` joined the declared refusal families, because those are the codes
  the shell's own error map already renders.
- macOS: `go build`, `go vet` (host and `GOOS=windows`), the full unit suite and
  the integration suite pass.

## Windows, and a session trap worth recording

The full Windows suite is green: `go build`, `go vet` and every package including
`internal/harnessruntime` and the runtime cases in `internal/core`.

Getting there cost one real fix and one environment finding.

1. **A requested stop is not a crash.** Windows reports a forced tree kill
   (`taskkill /t /f`) as an exit code, not as a signal, so the exit handler marked
   a deliberate stop as `failed` and the launch view lied about it. The shell never
   had this problem because its `stop` set the state after the tree was gone;
   `Stop` now records the stop explicitly. The Windows run found it, and only
   Windows could: on Unix the same path reports `SIGTERM` and was already correct.
2. **DPAPI does not work from session 0, so an SSH-driven run cannot test the
   credential store.** `internal/secret` failed every `Set` with
   `p2p.secret_write_failed` on this box while the same code passed an hour
   earlier. A twelve-line probe settled it: `windows.CryptProtectData` itself
   answers `Access is denied` in that session. `query session` shows why — the
   SSH login lands in the `services` session (0), while the box has an
   Administrator console session (1) with a loaded profile. Running the same suite
   through a one-shot scheduled task (which executes in session 1) gives a green
   `internal/secret`, including six of six stress runs. Every future Windows
   credential or stress run has to use that route; a failure from session 0 is an
   environment artefact, not a defect.

## Still to do

- The **shell switch**: `LauncherHarnessService` and the launcher window still run
  their own copy of this logic. Until they call the core, this is one writer too
  many, which is the whole point of the phase. That switch also has to carry the
  console push into the renderer and prove no orphan survives a killed shell,
  which is why 4.5's verification stays open.
