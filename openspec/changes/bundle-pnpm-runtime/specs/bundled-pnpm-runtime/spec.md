# Bundled pnpm runtime — specification

## Purpose

Run DSH Web and DSH package operations on a known standalone Node/pnpm pair.
DSH's native builtin loader requires a Node V8 context; Electron's
`ELECTRON_RUN_AS_NODE` process mode does not provide one.

## Requirements

### Requirement: The staged runtime is complete, target-specific, and verified

`tools/prepare-runtime.mjs` SHALL stage the official Node 22.23.3 binary and its
license, the pinned pnpm package, and `versions.json` with schema version 2,
platform, architecture, Node version, official archive name and SHA-256, staged
binary SHA-256, and pnpm version. Every supported target archive digest SHALL
be pinned in source. Preparation SHALL execute the staged binary, smoke
`pnpm --version`, and fail on any missing, mismatched, or un-runnable artifact.
`runtime:verify` SHALL validate the descriptor, actual binary digest, executable
version, and pinned pnpm pair without rewriting the stage.

#### Scenario: A fresh native stage passes

- **WHEN** pinned pnpm is installed and preparation runs on a supported native
  platform/architecture
- **THEN** the official archive digest is verified before extraction, the
  standalone Node and pnpm smoke succeeds, and `runtime:verify` passes

#### Scenario: A mismatched or foreign stage is rejected

- **WHEN** the stage has the wrong target, archive digest, binary digest,
  runtime version, unknown descriptor schema, or cannot execute
- **THEN** verification exits non-zero and does not rewrite the stage

### Requirement: DSH commands require the bundled standalone runtime

`resolvePnpmLauncher()` SHALL run the staged `node` binary with the pinned
`pnpm.mjs` entry and a command PATH that places the staged `bin` first. An absent
or incomplete runtime SHALL return a typed launch refusal. It SHALL NOT substitute
system Node, system pnpm, or the Electron executable.

#### Scenario: The complete stage is selected

- **WHEN** the descriptor and all required staged files match this build's
  platform and architecture
- **THEN** pnpm and DSH Web launch using `resources/runtime/bin/node` and
  `resources/runtime/pnpm/bin/pnpm.mjs`

#### Scenario: The stage is unavailable

- **WHEN** the descriptor, standalone Node, or pnpm entry is missing or invalid
- **THEN** the operation is refused with a runtime-preparation diagnostic and
  no process is spawned using a system or Electron runtime

### Requirement: Electron Node mode is never used for DSH subprocesses

The Electron `runAsNode` fuse SHALL remain disabled. The desktop's core spawn,
pnpm commands, and supervised DSH Web child SHALL remove inherited
`ELECTRON_RUN_AS_NODE` rather than set it. The private shell/core request schema
does not carry an Electron Node-mode flag and its method-table version remains
unchanged.

#### Scenario: Host environment contains the Electron mode flag

- **WHEN** the desktop or core inherits `ELECTRON_RUN_AS_NODE=1`
- **THEN** the standalone Node/pnpm and DSH Web child environment does not
  contain that variable

### Requirement: DSH native modules initialize on the bundled runtime

The real bundled Node SHALL provide the V8 context required by DSH's native
loader. A pnpm version probe alone SHALL NOT count as DSH Web startup acceptance.

#### Scenario: DSH Web starts successfully

- **WHEN** the launcher starts DSH Web with the staged standalone Node
- **THEN** `node-addon-require-builtin` loads
  `internal/modules/esm/loader`, host preparation succeeds, and DSH Web announces
  its loopback URL

### Requirement: Managed installation children use their registered Node

The core's managed `node` profile SHALL continue to run the installation's
registered Node executable and SHALL apply the staged runtime PATH so the DSH
plugin manager resolves the bundled pnpm. The bundled runtime SHALL NOT replace
the installation's registered Node or toolchain used for worktree preparation.

### Requirement: Target packaging and release checks cover shipped files

Target-specific `dist:*` scripts SHALL prepare the matching platform and
architecture. CI SHALL run each target on a native runner, including Linux
arm64. `release:smoke` SHALL verify that every unpacked app contains the target
Node executable and that its bytes match the descriptor digest.

#### Scenario: A missing or altered packaged runtime blocks release

- **WHEN** a packaged app lacks its standalone Node or its digest differs from
  `versions.json`
- **THEN** `release:smoke` reports the bundled-runtime check as failed
