# Design — bundle the standalone Node/pnpm runtime

## Runtime choice

The first implementation reused Electron with `ELECTRON_RUN_AS_NODE=1`. A real
DSH launch reached `node-addon-require-builtin` but failed with
`Unsupported/no-context` and `has_v8_context: false`. Electron 43's version
fingerprint did not change that runtime behavior. A separate Node 22.23.3
executable successfully loaded the same DSH native addon and its
`internal/modules/esm/loader` builtin, so the launcher packages that official
Node distribution instead. Electron remains at its existing version and its
`runAsNode` fuse is disabled.

## Staging

`tools/prepare-runtime.mjs` downloads and verifies the official archive for the
requested platform/architecture before extracting the Node executable and
license. It separately downloads Node's exact-version headers archive and
verifies its pinned source SHA-256 and extracted tree SHA-256. This is required
because official Windows Node ZIPs do not include `include/node`. It stages:

- `bin/node` or `bin/node.exe` — the independent official Node runtime.
- `bin/pnpm` and `bin/pnpm.cmd` — wrappers that invoke the sibling standalone
  Node and pinned `pnpm.mjs`.
- `pnpm/` — the pinned pnpm devDependency.
- `LICENSE.node` — license from the Node archive.
- `include/node/` — Node-API and V8 build headers required when DSH compiles
  native modules.
- `versions.json` — schema 4 target identity, Node version, Node and headers
  source archive identities and digests, executable and header-tree digests,
  and pinned pnpm version.

The stage is smoked with the staged executable before it is used. Verification
rechecks target, pinned archive identity, binary/header digests, executable
version, and pnpm version without changing the staged directory.

## Resolution and process wiring

- `resolvePnpmLauncher(resources/runtime)` requires the matching schema-4
  runtime, including the required Node headers, and returns the staged Node
  executable with `--expose-internals` and the pinned `pnpm.mjs` entry. Missing
  or incomplete files return a launch refusal; there is no system Node/pnpm or
  Electron-runtime substitution.
- `resources/runtime/bin` is first on the DSH child PATH so its plugin manager
  uses the same standalone Node and pnpm. Other inherited PATH entries remain
  available for normal tools such as Git.
- The desktop core and pnpm child environments strip inherited
  `ELECTRON_RUN_AS_NODE`; no launch mode bit or shell/core method-table change is
  needed.
- Managed installations keep their explicitly registered Node executable.
  Their child PATH can still resolve the bundled pnpm for plugin operations.
  Worktree preparation continues to use the toolchain recorded by that
  installation.

## Packaging and evidence

Target scripts pass exact platform and architecture values to runtime
preparation. Each packaging job runs on a matching native runner, including
Linux arm64, because preparation must execute the downloaded binary. The app
ships the runtime under `extraResources/runtime`. `runtime:verify` gates the
source stage, and packaged `release:smoke` verifies the target descriptor and
hashes of the actual shipped Node binary and complete headers tree.

The pnpm smoke is necessary but not sufficient: local DSH startup must also
prove the native addon loads, host preparation completes, and the Web URL is
announced.
