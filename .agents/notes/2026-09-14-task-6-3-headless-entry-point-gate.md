# Tasks 6.3 and 6.4 — the headless entry point is a gate, not a claim

Date: 2026-09-14
Change: `go-owned-headless-core` (P6, tasks 6.3 and 6.4)

## What this adds

The core binary is one artifact with two lives: the shell starts it as a child,
and an operator runs it with no desktop session. Everything up to now proved the
first life. `tools/headless-core-smoke.mjs` proves the second, on the machine
that built the artifact, and `npm run release:readiness` will not pass without
it.

The gate checks four things, in order, and writes
`.run/headless-core/latest.json` either way so a failure always leaves the
observation that explains it:

1. `core-binary` — the core for the target resolves, is a regular file, and its
   sha256 equals the manifest the app would verify at spawn. A missing, indirect
   or stale artifact fails here with the build command in the message.
2. `serve-publishes-its-own-endpoint` — `dshkerd serve --state <temporary
directory>` prints its readiness record and names the private endpoint it
   listens on.
3. `named-command-over-the-private-endpoint` — `status --json` answers over that
   endpoint, so the named commands reach the same table the app reaches.
4. `refusal-keeps-its-code` — `proxy` refuses a host with no child with
   `p2p.runtime_unavailable` on the terminal, which is the property 3.8 and 6.1
   exist for: a headless operator must be able to act on a code.

The target is explicit (`--target darwin-arm64` and so on) rather than taken
from the host, because a cross-built installer is verified where it was built: a
win32-arm64 core cannot execute on an x64 machine, and a gate that quietly
checked a different file would be worse than no gate. `--build` compiles the
target first, which is what the npm script does, so a clean checkout can run the
whole thing with one command.

## Wiring

- `npm run core:headless-smoke` builds the core for this machine and runs the
  gate.
- `tools/release-readiness-core.mjs` gains a `core-headless-smoke` stage after
  `package`: hard gate, evidence `.run/headless-core/latest.json`. It is
  excluded in template mode, where there is no core to build — the same treatment
  `package` and `release-smoke` already have.
- `.github/workflows/package.yml` runs the same script once per matrix entry
  with that entry's target, after `release:verify` and before the packaged app
  smoke. macOS arm64 and x64, Windows x64 and arm64 and Linux x64 are covered;
  Linux arm64 carries `smokeSkip` and is skipped for the same reason its
  packaged smoke is — the runner cannot execute it.

## Evidence

- `node tools/release-readiness.mjs --json` with every other stage skipped,
  which is how the new stage is verified in isolation: it reported
  `core-headless-smoke` with `ok: true` and its evidence path. The failure half
  is pinned by `tools/headless-core-smoke.test.mjs`, which runs the gate against
  an empty app root and asserts a non-zero exit, a `core-binary` failure and an
  evidence file that says so; the same file runs the real gate when this machine
  has a core for it.
- The full local run of the gate on this machine passes all four checks, and
  `tools/release-readiness.test.mjs` carries the new stage in the frozen plan
  order.
- The Windows and Linux legs run in the packaging workflow, which is where their
  evidence is produced rather than claimed here.

## Documentation

The CHANGELOG entry and both READMEs now describe the headless mode and its named
commands, because a machine reachable only over SSH becoming a usable host is a
user-visible capability rather than an internal one.
