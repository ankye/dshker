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
