# Agent Note: Bundle the pnpm runtime (reference: DSH Desktop)

Status: implemented

## Problem

Every DSH package operation DSHKer runs — the bundled-seed bootstrap,
`dsh plugin` commands, package lifecycle scripts, and the embedded Web Plugins
page — resolved `pnpm` (and through it `node`) from the user's system. A
desktop-launched app cannot reliably see an interactive shell's PATH, so a
machine with a working pnpm in every terminal could still refuse plugin
operations, and none of it worked without a system Node.

## Decision

Follow DeepSeek Harness Desktop's Electron-RunAsNode runtime: DSHKer ships no
separate Node — its own Electron executable is the Node runtime — and it
carries a pinned pnpm distribution beside tiny `node`/`pnpm` shell launchers.
The staged layout (`resources/runtime/`, gitignored) is produced by
`tools/prepare-runtime.mjs`: the Node version is probed from the local Electron
distribution (`ELECTRON_RUN_AS_NODE=1`, like the reference
`prepare-runtime.ts`), pnpm is copied from the pinned devDependency
(`pnpm@11.7.0`, matching the harness the Launcher manages), `versions.json`
records both, and the pair is smoke-tested (`pnpm --version`) before packing.
`runtime:verify` re-checks a stage against the probed and pinned versions as a
release gate — "look at the versions when packaging".

`resolvePnpmLauncher()` prefers the complete stage: `process.execPath` with
`--expose-internals` plus `resources/runtime/pnpm/bin/pnpm.mjs` and a bin-first
command PATH. An incomplete stage (missing descriptor/pnpm entry/bin) falls
back to the existing system resolution, so a development checkout that never
ran `runtime:prepare` keeps working. The core's pnpm profile already applied
`PnpmCommandSearchPath` as the child PATH; the managed `node` profile now does
too, so installation-launched Web sessions also resolve the bundled pnpm.
`DSHKER_NODE_EXECUTABLE` is injected once into the core's spawn environment and
into electron-side pnpm invocations, letting both shims and lifecycle scripts
run without a system Node.

## Consequences

- Packaging: `runtime:prepare` runs before every `electron-builder` invocation,
  `resources/runtime` ships as `extraResources/runtime`, and
  `electronFuses.runAsNode` is explicit. Release readiness gained a
  `runtime:verify` hard gate after packaging, and `release:smoke` now fails a
  `bundledRuntime` check when an unpacked build lacks a schema-valid runtime
  descriptor.
- The embedded Web Plugins page's default `pnpmCommand` (`pnpm`) resolves
  through the child's PATH to the bundled shim, which forwards to the bundled
  `pnpm.mjs` on the Launcher's own process.
- Boundary kept deliberately: managed-installation worktree preparation
  (`worktree-preparer`) still uses the user's explicitly registered pnpm
  toolchain — that flow is bound to the toolchain identity the installation
  record persists, so the bundled runtime covers runtime package operations
  (bundled-harness prepare/build, `dsh web`, `dsh plugin`, embedded Plugins
  pages) but not the managed-installation first build.
- The private bin is handed only to package-operation subprocesses (PATH via
  the pnpm launch facts and the managed child's PATH override); as in the
  reference, the Host's own environment is not polluted with the private bin.
- Windows caveat carried from the reference: code that directly spawns the
  literal `node` executable without a shell must use the Launcher's own
  executable.

## Alternatives considered

- System pnpm on PATH (status quo): keeps the toolchain requirement and the
  Finder/Explorer PATH blind spot.
- Bundling a separate upstream Node executable: duplicates the runtime and adds
  another signed binary; the reference explicitly rejected this in
  `2026-09-11-desktop-electron-node-runtime.md`.
- Global PATH prepend on the core: would leak the private bin into every core
  child, not just package operations.
