# Tasks — bundle the pnpm runtime

## Capability: bundled-pnpm-runtime

- [x] Add committed `resources/runtime-bin/` shell launchers (`node`, `node.cmd`, `pnpm`, `pnpm.cmd`).
- [x] Add the pinned `pnpm` devDependency and `tools/prepare-runtime.mjs` (probe Electron Node version, copy the pnpm package, write `versions.json`, smoke `pnpm --version`); add `runtime:prepare` and `runtime:verify` scripts.
- [x] Chain `runtime:prepare` into every `package`/`dist` script, ship `resources/runtime` via `extraResources`, and enable `electronFuses.runAsNode`.
- [x] Prefer the staged runtime in `resolvePnpmLauncher()`; expose `bundledPnpmEntry`; fall back to the system resolution for an incomplete stage.
- [x] Inject `DSHKER_NODE_EXECUTABLE` into the core spawn environment and `pnpmCommandEnvironment`.
- [x] Apply `PnpmCommandSearchPath` as the child PATH override for the core's managed `node` profile; pass it through `ManagedHarnessWebRuntimeSupervisor` and `main.ts`.
- [x] Cover the resolution, env, supervisor, and core command behavior with tests (TS and Go).
- [x] Run `runtime:prepare`, `type-check`, `architecture:check`, `format:check`, the full vitest suite, Go tests, and `build:electron`.
- [x] Add `runtime:verify` as a release-readiness hard gate and a `bundledRuntime` packaged-artifact check in `release:smoke`; update their tests.
- [x] Document the managed-installation worktree-preparation boundary (registered toolchain) in the spec, design, and Agent Note.
- [x] Update `CHANGELOG.md`, both READMEs, and `docs/release.md`; add the Agent Note.