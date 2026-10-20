## Context

See `proposal.md` for the user-visible problem. The Launcher currently starts its headless core with the environment inherited by Electron and supplies a bundled-runtime PATH to the supervised DSH child. A desktop-launched macOS/Linux application does not inherit interactive shell profile changes, so the current environment can omit commands that work in the user's terminal.

## Goals / Non-Goals

**Goals:**
- Resolve shell PATH only when starting DSH, so opening the Launcher remains independent of shell startup latency.
- Keep PATH composition in the trusted main process and existing runtime launch contract; do not add renderer filesystem or shell access or a new IPC capability.
- Keep the runtime's existing non-PATH environment intact.

**Non-Goals:**
- Import shell aliases, functions, prompt state, or arbitrary shell-session variables into DSH.
- Change Windows shell profiles or any OS-wide/user-wide PATH configuration.
- Modify DeepSeek Harness source or Cocos CLI behavior.

## Decisions

1. **Resolve POSIX PATH from the configured login-interactive shell on demand.** Use the absolute `SHELL` executable from the Launcher process environment and invoke it directly with a fixed argument vector and a bounded timeout. Parse one uniquely marked PATH value from stdout; disregard profile chatter outside the marker and reject missing, duplicate, empty, or malformed markers. Support zsh, bash, sh/dash (login mode via `argv0`), and fish (with its own PATH-join expression). Refuse the DSH launch on shell lookup or execution failure instead of silently using the desktop's incomplete PATH.
   - Alternative rejected: infer common tool locations such as `~/.local/bin`, Homebrew, or Node-manager directories. Those are machine-specific guesses and violate the no-fallback rule.
   - Alternative rejected: run an arbitrary user-supplied shell command or expose shell execution to the renderer. The executable and command are fixed by the main-process implementation.
2. **Compose a child-only PATH.** Keep the bundled Node/pnpm runtime first, retain every entry already in DSHKer's PATH, then append unique login-shell entries. Pass the result through the existing `pnpmCommandSearchPath` field. The Windows path is the inherited process PATH plus the existing bundled runtime entry; its environment variable lookup and duplicate elimination are case-insensitive. If Windows has no inherited PATH, refuse rather than starting with only the bundled path. Do not assign to `process.env.PATH`.
3. **Keep the resolver lazy and shared per Launcher process.** Create one cached resolver used by both the default DSH launch and managed-installation DSH launch. Cache only a successful result; a failed lookup is reported and may be retried on a later explicit launch. The shell runs only when DSH launch is requested, not at app startup or for unrelated P2P operations.
4. **Use the existing typed launch-failure surface.** A resolver failure is converted to the existing `runtime.spawn_failed` code with a specific non-secret message and is recorded in the DSH launch log. The app must not start a second process using a guessed PATH.
5. **Test both layers.** Unit tests cover shell-output parsing, bounded failure, path ordering/deduplication, Windows inherited PATH, and scope isolation. A core supervisor test launches a child with a supplied PATH and marker variable to prove that adding PATH does not drop other inherited environment entries.

## Risks / Trade-offs

- [Interactive shell startup scripts may be slow or fail] → Resolve lazily at the first DSH launch, bound execution time and captured output, cache only success, and report a typed failure without changing the selected DSH executable.
- [Shell profiles can print arbitrary stdout] → Parse only a unique marker pair and keep all profile output out of the resolved PATH.
- [A user's configured shell may not be supported] → Refuse clearly; do not guess a different shell or fall back to a partial path.
- [PATH can contain paths with spaces] → Preserve each path value as data and use the OS path delimiter without shell splitting.

## Migration Plan

No persistent data or protocol migration is required. Release the Launcher change with the existing DSH runtime request schema. Rollback consists of reverting the Launcher change; no OS or user configuration was modified.
