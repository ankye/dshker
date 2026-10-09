# Agent Note: DSH version-switch native build recovery

## Observed failure

The 2026-10-09 `~/.dshlauncher/logs/dsh-web.log` version-switch attempt fetched
and installed the selected Harness commit, then `pnpm run build` stopped because
the Launcher's bundled Node lacked `include/node`. DSH's native build requires
the official Node development headers. A retry then failed because the removed
failed checkout remained registered in the Harness repository's Git worktree
metadata.

## Repair

- Stage the complete `include/node` directory from Node's separate official
  headers archive for the same Node 22.23.3 version. Pin and verify the archive
  SHA-256, then record the deterministic extracted tree SHA-256 in runtime
  descriptor schema 4; runtime verification and packaged release smoke validate
  the source identity, actual tree digest, and required files. Target Windows
  ZIPs do not contain these headers.
- Before retrying an incomplete commit, list Git worktrees and remove only the
  exact target registration when present. Verify it is gone before recreating
  the worktree. Do not prune unrelated worktrees. The active version pointer is
  written only after build and compatibility validation succeed.

## Verification

- Historical pre-CI check: the official Node 22.23.3 darwin-arm64 archive
  staged into an isolated temporary runtime, recorded schema 3 with a
  header-tree digest, and passed
  `runtime:verify`; the repository's pre-existing ignored runtime stage was not
  replaced.
- The exact failing Harness commit was exported into a temporary source tree.
  Its `native/system/scripts/build.ts --host-addon-only` completed using the
  isolated bundled Node and produced `darwin-arm64/bin/system.node`.
- The regression test created a real temporary Git repository, failed a target
  build, removed its directory while preserving Git's stale registration,
  retried that same commit, and verified successful readiness and pointer flip.
- The first `v0.1.86` GitHub package workflow exposed that Windows Node ZIPs omit
  `include/node`; Windows x64 and arm64 failed at runtime preparation before
  packaging. The matching official headers archive and extracted tree were
  verified against the pinned archive checksum and computed tree digest before
  fixing the staging path. In the repaired release workflow, Windows x64 and
  arm64 both staged the headers, built the unsigned installer, passed metadata,
  headless-core and packaged-application smoke checks, and uploaded their
  artifacts.
- The first retry then stopped in source tests because Vitest treated the live
  archive-check script as a test module and supplied a non-file module URL.
  Moved that script under `tools/test/` without a Vitest test suffix and ran it
  as a dedicated Node command. Full suite: 1,526 tests across 170 files passed;
  the dedicated integrity gate also passed with live archive evidence.
- Focused regression: 32 tests passed. Environment, format, architecture,
  types, service smoke, visual smoke, web build, Electron source build,
  desktop-app validation, test-integrity checks, and source-file-size checks
  passed. No local Launcher installer was built.
- Repaired workflow run `37908718234` completed successfully. All six desktop
  targets and six standalone CLI targets passed; stable GitHub Release
  `v0.1.86` was published with 25 assets, including Windows x64 and arm64
  installers. The release tag resolves to commit
  `adfdc2d6bb22c96a50fba8f30d02a855cf9b546c`.
