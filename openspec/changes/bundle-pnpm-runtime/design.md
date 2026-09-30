# Design — bundle the pnpm runtime

## Reference

The implementation mirrors DeepSeek Harness Desktop's bundled runtime
(`apps/desktop/scripts/prepare-runtime.ts`, `scripts/node-bin/`, and the
`packageManager` launch facts in `apps/desktop-host`): the application's own
Electron executable is the Node runtime (`ELECTRON_RUN_AS_NODE=1
--expose-internals`), the pinned pnpm distribution ships beside small
`node`/`pnpm` shell launchers, and the packaged node/pnpm versions are probed
and recorded at build time and smoke-tested before packing. DSHKer adds no
binary: its own `process.execPath` is Node, and its private `bin` directory is
handed only to package-operation subprocesses.

## Staging

`tools/prepare-runtime.mjs` writes `resources/runtime/` (gitignored):

- `bin/node`, `bin/node.cmd` — forward to `"$DSHKER_NODE_EXECUTABLE"
  --expose-internals "$@"` in Node mode.
- `bin/pnpm`, `bin/pnpm.cmd` — forward to the sibling
  `../pnpm/bin/pnpm.mjs` the same way; this is what the embedded Web Plugins
  page's default `pnpmCommand` (`pnpm`) resolves through PATH.
- `pnpm/` — the pinned `pnpm@<exact>` devDependency copied from
  `node_modules/pnpm`.
- `versions.json` — `{ schemaVersion: 1, node, pnpm }` where `node` is probed
  from the local Electron distribution and `pnpm` is read from the pinned
  manifest. `runtime:verify` re-checks both against the stage and re-smokes
  `pnpm --version`.

## Resolution and wiring

- `resolvePnpmLauncher(bundledRuntimeRoot)` prefers the complete stage: 
  `executable = process.execPath`, `prefixArguments = ['--expose-internals',
  <runtime>/pnpm/bin/pnpm.mjs]`, `commandSearchPath = <runtime>/bin:…`. An
  incomplete stage (missing pnpm entry, bin, or a schema-version-1 descriptor)
  falls back to the existing system resolution; a development checkout that
  never staged the runtime is unchanged.
- The pnpm-profile launch (`pnpm [prefix…] dsh web --patch … --no-open`) and
  every electron-side pnpm invocation therefore run on the bundled pair. The
  core already applies `PnpmCommandSearchPath` as the child PATH for that
  profile.
- The managed node-profile launch runs the installation's own Node; the core's
  `BuildCommand` now applies `PnpmCommandSearchPath` as the child PATH there
  too, so its embedded plugin manager resolves the bundled pnpm.
- `DSHKER_NODE_EXECUTABLE` is set on the core's spawn environment and in
  `pnpmCommandEnvironment`, so lifecycle scripts and both shims find the
  Launcher's Electron without a system Node. The variable is inert when the
  bundled bin is not on PATH.

## Packaging

`package.json` pins `pnpm`, runs `runtime:prepare` before every
`electron-builder` invocation, ships `resources/runtime` as
`extraResources/runtime`, and enables `electronFuses.runAsNode`. Release
readiness adds a `runtime:verify` hard gate after packaging, and
`release:smoke` verifies the packaged `resources/runtime/versions.json`
descriptor in every unpacked build.

## Boundaries

The managed-installation worktree preparation (`worktree-preparer.mjs`) keeps
its explicitly registered pnpm toolchain: that flow is bound to the toolchain
identity the installation record persists, and substituting the bundled pnpm
would bypass the user's registered choice. The bundled runtime covers package
operations at runtime — the bundled-harness prepare/build, `dsh web` launches,
the plugin panel's `dsh plugin` commands, and every embedded Web Plugins page —
not the managed-installation first build.