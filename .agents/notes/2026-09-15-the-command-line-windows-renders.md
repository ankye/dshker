# The command line Windows actually renders

Date: 2026-09-15

## What was reported

Launching the local workbench failed with `runtime.port_in_use` while the log said
nothing more than the code, at a moment when no launcher was running and the port
had been free minutes earlier.

## What was actually wrong

The port preflight was already the behaviour the user asked for: `PreparePortForLaunch`
finds the process listening on a fixed port and, when it recognizes a leftover DSH
Web that the Launcher itself started, stops it and launches past it
(`PortCleared`); anything else is a refusal naming the holder.

The recognition rule was the bug:

```go
regexp.MustCompile(`\bdsh web\b|\bbin\.(?:j|t)s web\b`)
```

Windows renders a spawned process's command line with every argument quoted, so
the actual holder read:

```
node --import tsx/esm apps/cli/src/bin.ts "web" "--patch" "C:\...\resources\verbose.patch.yml" "--no-open" "--port" "31888"
```

`bin.ts "web"` does not match `bin\.(?:j|t)s web`, so the Launcher's own leftover
was classified as a foreign program and the launch was refused — with a message
whose useful half (pid and command line) never leaves the core, because only the
public code crosses the private channel. The result was a launch that could not
succeed, a cause that could not be seen, and a port that stayed held.

It was reproducible without any of that: the same command line matches when the
subcommand is unquoted (`bin.ts web`), and the pnpm wrapper form matches either way
(`pnpm.mjs dsh web`). The failure therefore depended on how the platform happened
to quote one argument.

## What changed

- Both copies of the rule (`networking/internal/harnessruntime/preferences.go` and
  `electron/main/managed/port-occupancy.ts`) accept optional quotes around the
  tokens: `(?:\bdsh\b|bin\.(?:j|t)s)["']?\s+["']?web\b`. The trailing `\b` is what
  keeps a near miss foreign — `bin.js webhook` is not a workbench, and adopting it
  would stop a process that is not ours at all.
- `electron/main/managed/launch-failure.ts` gives the launcher log a sentence for
  the codes whose remedy is not obvious from the name. `runtime.port_in_use` now
  says the port is held by another process, that this is usually a leftover
  workbench, and that it can be stopped or another port chosen in Settings.
- Both matchers are pinned by the command lines observed on the machine that
  reported it, quoted and unquoted, plus the near misses.

## Not done, deliberately

The preflight still kills only a process it recognizes as a DSH Web; an unknown
holder is refused with the port and pid named. Recognition by _our own record_ of
the child (a pid file written at spawn) would be stronger than recognition by
command line, and is the natural next step if this rule ever needs a third case.
