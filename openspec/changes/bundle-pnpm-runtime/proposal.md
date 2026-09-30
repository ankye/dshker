## Why

DSHKer manages DeepSeek Harness installations, but every package operation — the bundled-seed bootstrap, `dsh plugin` commands, and the embedded Web Plugins page — currently resolves `pnpm` (and through its lifecycle scripts, `node`) from the user's system. A machine whose pnpm or Node installation is missing, outdated, or invisible to a desktop-launched process cannot install or repair plugins, and the Launcher's toolchain requirements leak into what should be an appliance-like product.

DeepSeek Harness Desktop solves the same problem by carrying the runtime itself: its `ELECTRON_RUN_AS_NODE=1` Electron binary is the Node, its pinned pnpm distribution ships beside `node`/`pnpm` shell launchers, and the packaged node/pnpm versions are probed and recorded at build time. DSHKer is also an Electron application, so the same design applies with no extra binary: the Launcher's own process is the Node runtime.

## What Changes

- Add a staged bundled runtime under `resources/runtime/`, generated and versioned by `tools/prepare-runtime.mjs`: `bin/` shell launchers (`node`, `node.cmd`, `pnpm`, `pnpm.cmd`), the pinned pnpm package, and a `versions.json` descriptor recording the probed Electron Node version and the pinned pnpm version.
- Prefer the staged runtime in `resolvePnpmLauncher()`: the pnpm launch facts become the Launcher's own Electron binary with `--expose-internals` plus the bundled `pnpm.mjs`, and a bin-first command PATH. An incomplete stage falls back to the existing system resolution so development checkouts keep working.
- Inject `DSHKER_NODE_EXECUTABLE` into the core's spawn environment and every electron-side pnpm invocation, so the bundled `node`/`pnpm` launchers and package lifecycle scripts run without a system Node.
- Extend the core's managed `node` profile so the staged runtime's PATH override reaches installation-launched Web children, giving their embedded plugin manager the same bundled pnpm.
- Package the runtime with the app (`extraResources`) and keep the `runAsNode` fuse enabled; run `runtime:prepare` before every `electron-builder` invocation. `runtime:verify` re-checks a staged runtime against the pinned versions as a release gate.

## Capabilities

### New Capabilities

- `bundled-pnpm-runtime`: stage, version, smoke-test, package, and resolve the Launcher's own Node/pnpm runtime for every DSH package operation.

### Modified Capabilities

- None.

## Impact

- `resources/runtime-bin/` gains the committed shell launcher sources; `resources/runtime/` is generated output and gitignored.
- `tools/prepare-runtime.mjs` stages the runtime, records versions, and smokes the pair; `runtime:verify` re-validates.
- `electron/main/pnpm-launcher.ts` prefers the staged runtime over the system resolution.
- `electron/main/core/supervisor.ts` and `launcher-harness-commands.ts` carry the Launcher Electron identity for package subprocesses.
- `networking/internal/harnessruntime` applies the bundled PATH override to managed (node-profile) children.
- `package.json` pins the pnpm devDependency, runs `runtime:prepare` before packaging, ships `resources/runtime`, and enables the `runAsNode` fuse.
- `CHANGELOG.md`, both READMEs, and `docs/release.md` document the runtime and the packaging version gate.