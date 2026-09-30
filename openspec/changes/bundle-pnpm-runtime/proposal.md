## Why

DSHKer needs its own predictable Node and pnpm for DSH Web and plugin package
operations. The original Electron-RunAsNode approach failed in a real DSH launch:
`node-addon-require-builtin` reported `Unsupported/no-context` because the
embedded runtime had no usable V8 context. Switching Electron versions did not
solve the missing context. A pinned official standalone Node distribution does.

## What changes

- Stage an official, SHA-256-pinned Node 22.23.3 binary and license for each
  supported platform/architecture, alongside the pinned pnpm package.
- Record target, archive and executable identity in a versioned runtime
  descriptor; smoke and verify the actual standalone Node/pnpm pair.
- Require the staged runtime and fail clearly if it is missing or invalid; do
  not substitute system Node/pnpm or Electron Node mode.
- Keep Electron's `runAsNode` fuse disabled and strip any inherited
  `ELECTRON_RUN_AS_NODE` from child processes.
- Prepare each target's own runtime on native CI runners, including Linux arm64,
  and validate the shipped Node executable against its descriptor.
- Keep managed-installation Node registrations and worktree toolchains intact.

## Capabilities

### New capabilities

- `bundled-pnpm-runtime`: stage, verify, package, and resolve standalone Node and
  pinned pnpm for DSH runtime/package operations.

### Modified capabilities

- None.

## Impact

- `tools/prepare-runtime.mjs`, target package scripts, Electron child
  environments, and Go supervised child environments.
- Runtime packaging, release smoke checks, OpenSpec, changelog, READMEs, and
  runtime documentation.
