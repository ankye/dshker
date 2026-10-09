# Tasks — bundle standalone Node and pnpm

## Capability: bundled-pnpm-runtime

- [x] Pin official Node 22.23.3 archive names and digests for all supported targets.
- [x] Stage Node binary/license plus pinned pnpm under `resources/runtime` and record schema-2 identity.
- [x] Smoke and verify the actual staged executable; reject target, digest, version, and missing-file drift.
- [x] Require the staged runtime in the launcher and refuse system/Electron substitution.
- [x] Strip inherited Electron Node mode from desktop, pnpm, and supervised child environments; keep shell/core protocol at version 1.
- [x] Pass explicit runtime targets from each platform package script.
- [x] Use a native Linux arm64 runner so the target runtime can be executed during packaging.
- [x] Verify packaged runtime descriptors and the actual Node executable digest in release smoke.
- [x] Update tests, OpenSpec, Agent Note, changelog, READMEs, architecture, and release docs.
- [x] Run focused tests, test-integrity static checks, and the source-file-size gate.
- [x] Run the local app against the installed DSH checkout; confirm native host preparation, DSH Web URL readiness, and the embedded workbench renders.
- [x] Complete GitHub Actions release gates and native packaged artifacts; publish stable `v0.1.85` with verified release assets.
- [x] Stage Node headers and require their digest in runtime schema 4.
- [x] Stage headers from the separate official Node archive when target distributions omit them; pin the archive digest and record and verify the extracted tree digest in runtime schema 4.
- [x] Recover a failed version preparation by removing only the exact stale Git worktree registration before retry.
- [x] Add regression coverage for missing build headers and the failed-switch/retry worktree sequence.
- [x] Run focused runtime/version-switch checks, project validation, and source-file-size validation.
- [x] Complete the repaired `v0.1.86` native GitHub package matrix and verify published release assets.
- [ ] Accept Windows canonical/8.3 path aliases while rejecting symbolic-link or junction components in managed worktree admission.
