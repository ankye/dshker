# Bundled Node 24 upgrade — specification delta

## MODIFIED Requirements

### Requirement: The staged runtime is complete, target-specific, and verified

`tools/prepare-runtime.mjs` SHALL stage the official Node 24.22.3 binary, its
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

#### Scenario: A stage from the previous Node pin is rejected

- **WHEN** the stage still describes or carries the previous pinned Node
  (22.23.3) after the pin moved to 24.22.3
- **THEN** verification and `resolvePnpmLauncher` refuse the stage and require
  re-running `runtime:prepare`, without substituting system Node/pnpm

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
