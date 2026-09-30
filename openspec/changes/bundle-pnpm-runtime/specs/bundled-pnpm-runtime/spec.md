# Bundled pnpm runtime — specification

## Purpose

Let every DSH package operation (bundled-seed bootstrap, `dsh plugin` commands, the embedded Web Plugins page, and package lifecycle scripts) run on the Launcher's own Node and pnpm instead of a system installation, with the runtime's node/pnpm versions probed, recorded, and smoke-tested as a packaging gate. The design follows DeepSeek Harness Desktop's Electron-RunAsNode runtime.

## Scenario

- **WHEN** DSHKer is packaged
- **THEN** `runtime:prepare` has staged a complete runtime (bin launchers, pinned pnpm, `versions.json`) based on the very Electron binary the app will run, and the release ships it under `resources/runtime`
- **AND** `dsh web`, `dsh plugin`, and the embedded Plugins page resolve pnpm through the staged bundle
- **AND** a user with no Node or pnpm installed can install, update, and remove plugins

## Requirements

### Requirement: The staged runtime is complete and versioned

`tools/prepare-runtime.mjs` SHALL stage `bin/` shell launchers (`node`, `node.cmd`, `pnpm`, `pnpm.cmd`), the pinned pnpm package, and a `versions.json` descriptor with `schemaVersion: 1`, the Node version probed from the packaged Electron executable (`ELECTRON_RUN_AS_NODE=1`), and the pnpm version read from the pinned devDependency. It SHALL smoke `pnpm --version` on the staged pair and fail the packaging run on any missing piece, probe failure, or version mismatch. `runtime:verify` SHALL re-check a staged runtime against the same probed and pinned versions.

#### Scenario: A fresh stage passes

- **WHEN** the pinned pnpm devDependency is installed and the Electron distribution is present
- **THEN** `npm run runtime:prepare` stages a complete runtime, `versions.json` matches the probed Electron Node version and pinned pnpm version, and `npm run runtime:verify` passes

#### Scenario: A version drift fails the gate

- **WHEN** the staged `versions.json` names a Node or pnpm version that no longer matches the packaged Electron or the pinned devDependency
- **THEN** `runtime:verify` exits non-zero without modifying the stage

### Requirement: The bundled runtime takes precedence, with a system fallback

`resolvePnpmLauncher()` SHALL return the staged runtime's launch facts when a complete stage exists: the Launcher's own `process.execPath` as the executable, `--expose-internals` plus the bundled `pnpm.mjs` as prefix arguments, and a bin-first command PATH. When the stage is absent or incomplete, it SHALL keep the existing system resolution, so a development checkout without a staged runtime still works.

#### Scenario: Staged runtime wins

- **WHEN** `resources/runtime` holds a complete stage
- **THEN** the resolved launcher executes the bundled `pnpm.mjs` on the Launcher's own process and prepends `resources/runtime/bin` to its PATH

#### Scenario: Incomplete stage falls back

- **WHEN** the stage lacks `versions.json`, the pnpm entry, or the bin directory
- **THEN** resolution falls back to the system pnpm exactly as before the change

### Requirement: The package carries the runtime and the Node-mode fuse

The packaged application SHALL ship `resources/runtime` as `extraResources/runtime` and SHALL keep the Electron `runAsNode` fuse enabled so the packaged process can act as the Node runtime.

#### Scenario: Packaged layout resolves

- **WHEN** the packaged app starts
- **THEN** `process.resourcesPath/runtime` contains the staged bin, pnpm, and `versions.json`, and `resolvePnpmLauncher` prefers it

### Requirement: The Launcher's Electron identity reaches package subprocesses

The core's spawn environment and every electron-side pnpm invocation SHALL carry `DSHKER_NODE_EXECUTABLE` naming the Launcher's own executable, so the bundled `node`/`pnpm` launchers and package lifecycle scripts resolve without a system Node.

#### Scenario: Lifecycle scripts run without a system Node

- **WHEN** a plugin package runs a lifecycle script that invokes `node`
- **THEN** the bundled `node` launcher forwards to the Launcher's own process in Node mode with `--expose-internals`

### Requirement: Managed installation children resolve the bundled runtime

The core's managed `node` profile SHALL apply the request's `pnpmCommandSearchPath` as the child PATH override when a staged runtime is present, so installation-launched Web sessions use the bundled pnpm and node; an empty search path SHALL leave the child on the inherited PATH unchanged.

#### Scenario: A managed Web session uses bundled pnpm

- **WHEN** an installation is launched from a packaged app with a staged runtime
- **THEN** the core spawns the child with the bundled bin directory first on PATH and its plugin manager resolves the bundled `pnpm`

### Requirement: Worktree preparation keeps the registered toolchain

Preparing a managed installation's source worktree (`pnpm install --frozen-lockfile` in `worktree-preparer`) SHALL keep using the user's explicitly registered pnpm toolchain. The bundled runtime serves package operations at runtime — launched Web sessions and plugin management — and does not substitute for the toolchain identity the managed-installation record binds, which must stay fail-loud about missing or version-mismatched registered tools.

#### Scenario: A managed workspace's first build uses the registered pnpm

- **WHEN** a managed installation is cloned and its worktree prepared on a machine without the bundled runtime staged
- **THEN** preparation still proceeds with the registered toolchain and reports the same typed refusal it does today when that toolchain is missing

### Requirement: Packaging and release gates verify the bundled runtime

The `package`/`dist` scripts SHALL run `runtime:prepare` before `electron-builder`, and release readiness SHALL include a `runtime:verify` hard gate after packaging. The packaged-app release smoke SHALL additionally confirm every unpacked build carries `resources/runtime/versions.json` with `schemaVersion: 1` and non-empty `node` and `pnpm` values.

#### Scenario: A release with a stale or absent runtime fails the gates

- **WHEN** a packaged build lacks the runtime descriptor or its recorded versions stop matching the pinned pair
- **THEN** `runtime:verify` exits non-zero and `release:smoke` reports a failed `bundledRuntime` check