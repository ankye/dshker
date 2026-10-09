# Bundled pnpm runtime — specification

## Purpose

Run DSH Web and DSH package operations on a known standalone Node/pnpm pair.
DSH's native builtin loader requires a Node V8 context; Electron's
`ELECTRON_RUN_AS_NODE` process mode does not provide one.

## Requirements

### Requirement: The staged runtime is complete, target-specific, and verified

`tools/prepare-runtime.mjs` SHALL stage the official Node 22.23.3 binary, its
license and complete `include/node` headers, the pinned pnpm package, and
`versions.json` with schema version 4, platform, architecture, Node version,
the target Node archive name and SHA-256, the exact-version official headers
archive name and SHA-256, staged binary and headers-tree SHA-256, and pnpm
version. Every supported target archive digest and the headers archive digest
SHALL be pinned in source; the extracted headers-tree digest SHALL be recorded
in the descriptor and checked against the staged files. The headers archive is separate because
official Windows Node ZIPs do not contain `include/node`. Preparation SHALL
execute the staged binary, smoke `pnpm --version`, and fail on any missing,
mismatched, or un-runnable artifact. `runtime:verify` SHALL validate the
descriptor, actual binary and headers digests, executable version, and pinned
pnpm pair without rewriting the stage.

#### Scenario: A fresh native stage passes

- **WHEN** pinned pnpm is installed and preparation runs on a supported native
  platform/architecture
- **THEN** the official archive digest is verified before extraction, the
  standalone Node and pnpm smoke succeeds, and `runtime:verify` passes

#### Scenario: A mismatched or foreign stage is rejected

- **WHEN** the stage has the wrong target, archive digest, binary or headers
  digest, missing Node build headers, runtime version, unknown descriptor
  schema, or cannot execute
- **THEN** verification exits non-zero and does not rewrite the stage

#### Scenario: A platform archive does not carry Node headers

- **WHEN** a target Node archive omits `include/node`, as the official Windows
  ZIPs do
- **THEN** preparation obtains the exact-version official headers archive,
  validates its pinned archive digest, records the extracted tree digest, and
  stages those headers; a
  missing or mismatched headers archive fails preparation without substitution

### Requirement: DSH commands require the bundled standalone runtime

`resolvePnpmLauncher()` SHALL run the staged `node` binary with the pinned
`pnpm.mjs` entry and a command PATH that places the staged `bin` first. An absent
or incomplete runtime SHALL return a typed launch refusal. It SHALL NOT substitute
system Node, system pnpm, or the Electron executable.

#### Scenario: The complete stage is selected

- **WHEN** the descriptor, Node build headers, and all required staged files
  match this build's platform and architecture
- **THEN** pnpm and DSH Web launch using `resources/runtime/bin/node` and
  `resources/runtime/pnpm/bin/pnpm.mjs`

#### Scenario: The stage is unavailable

- **WHEN** the descriptor, standalone Node, Node build headers, or pnpm entry is
  missing or invalid
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

### Requirement: A failed version preparation can be retried without damaging the active version

Before retrying an incomplete target version, the version store SHALL inspect
Git's registered worktree paths. If the exact target is registered, it SHALL
remove only that worktree and verify the registration is gone before creating a
fresh worktree. If it is not registered, it SHALL remove only the exact target
directory. A failed build SHALL NOT update the active-version pointer.
If the incomplete target is the currently active version, the operation SHALL
refuse without deleting or rebuilding that directory.

Direct filesystem admission SHALL inspect every path component for symbolic
links or Windows junctions. It SHALL accept a normalized absolute path when the
filesystem reports an equivalent canonical spelling, including Windows 8.3
aliases.

#### Scenario: A missing failed worktree directory remains registered

- **WHEN** a failed version build leaves a Git worktree registration but its
  target directory has been removed, and the user retries that same version
- **THEN** the stale registration is removed, the exact commit is prepared
  again, and the active-version pointer changes only after successful build
  and validation

#### Scenario: The incomplete target is still active

- **WHEN** the selected commit matches the active pointer but its prepared
  checkout is incomplete
- **THEN** the operation returns a typed error without removing the active
  checkout or changing the pointer

### Requirement: Target packaging and release checks cover shipped files

Target-specific `dist:*` scripts SHALL prepare the matching platform and
architecture. CI SHALL run each target on a native runner, including Linux
arm64. `release:smoke` SHALL verify that every unpacked app contains the target
Node executable and complete Node headers tree and that both match their
descriptor digests.

#### Scenario: A missing or altered packaged runtime blocks release

- **WHEN** a packaged app lacks its standalone Node, required headers, or either
  digest differs from `versions.json`
- **THEN** `release:smoke` reports the bundled-runtime check as failed
