# Agent Note: DSH version-switch native build recovery

## Observed failure

The 2026-10-09 `~/.dshlauncher/logs/dsh-web.log` version-switch attempt fetched
and installed the selected Harness commit, then `pnpm run build` stopped because
the Launcher's bundled Node lacked `include/node`. DSH's native build requires
the official Node development headers. A retry then failed because the removed
failed checkout remained registered in the Harness repository's Git worktree
metadata.

## Repair

- Stage the complete `include/node` directory from the same checksum-verified
  Node 22.23.3 distribution as the executable. Record its deterministic tree
  SHA-256 in runtime descriptor schema 3; runtime verification and packaged
  release smoke validate the required files and digest.
- Before retrying an incomplete commit, list Git worktrees and remove only the
  exact target registration when present. Verify it is gone before recreating
  the worktree. Do not prune unrelated worktrees. The active version pointer is
  written only after build and compatibility validation succeed.

## Verification

- The official Node 22.23.3 darwin-arm64 archive staged into an isolated
  temporary runtime, recorded schema 3 with a header-tree digest, and passed
  `runtime:verify`; the repository's pre-existing ignored runtime stage was not
  replaced.
- The exact failing Harness commit was exported into a temporary source tree.
  Its `native/system/scripts/build.ts --host-addon-only` completed using the
  isolated bundled Node and produced `darwin-arm64/bin/system.node`.
- The regression test created a real temporary Git repository, failed a target
  build, removed its directory while preserving Git's stale registration,
  retried that same commit, and verified successful readiness and pointer flip.
- Focused regression: 31 tests passed. Full suite: 1,521 tests across 170 files
  passed. Environment, format, architecture, types, service smoke, visual
  smoke, web build, Electron source build, desktop-app validation, test-integrity
  static checks, and source-file-size checks passed.
- No Launcher package was created and no tag or Release was published.
