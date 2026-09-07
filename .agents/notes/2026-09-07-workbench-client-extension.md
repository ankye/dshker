# Workbench client extension implementation

## Authorized scope

The user explicitly approved adding the missing DSH client extension and continuing the complete feature. The extension is an independent Launcher-owned package, `packages/dshker-workbench-client`; no Harness checkout or independent Go server source was modified. OpenSpec tasks 9.1/9.2 record public-service navigation, guest admission, compatibility and actual-runtime prerequisites. Previous ownership approval is no longer a blocker.

## Implemented modules

- Versioned request/readback validation with bounded identifiers/path, exact fields, no credentials or arbitrary executable/channel parameters.
- Public `ISessions` / `IWorkspaces` adapter, refresh/feed synchronization, membership/path verification, actual selected-identity readback, explicit stale/busy/timeout/cancellation states and no command/session creation replay.
- Client-only plugin metadata and reversible registration. Built bundle is self-contained and has no runtime imports, test inputs or Harness source.
- Main-process guest registrations bind computer/attempt/runtime generation and exact loopback origin. Only the registered main frame can mark readiness or settle a matching request. Abort/navigation/unregister invalidates pending operations and forwards named cancellation. Disposal removes guest and IPC listeners.
- Separate sandboxed guest preload build entry exposes only the frozen named workbench capability. Existing webview security policy still rejects arbitrary preloads; the new entry is not enabled globally.

## Checks and limits

- `node tools/build-workbench-client.mjs --harness-root /Users/a1021500932/.dshlauncher/versions/a66e4702047846cdaa10c66c9d3df3951f5ea70d` checks against the selected Harness's real exported declarations, then bundles production entries with a dependency-input scan. Output under package `lib/` is ignored generated content.
- Focused Vitest tests cover navigation, exact identity/path results, membership waiting, replay/concurrency, timeout/unload, named cancellation and main guest admission. Test-side service/Electron doubles are diagnostic unit tests, not a running DSH client proof.
- Root `npm run type-check` and `npm run build:electron` were run; preload output imports only Electron, without sandbox-incompatible relative chunk imports.
- No complete desktop or one-hour/physical-platform acceptance is claimed. Full quality-engineering verify remains blocked by incomplete scope/evidence.
- Current continuation: full Vitest run passed 97 files / 575 tests with explicit canonical `TMPDIR=/private/var/folders/8l/k98lf_j109g_07p3px4r09nc0000gn/T`. The initial default-TMPDIR run failed three existing pnpm-launcher assertions due to `/var` versus `/private/var`; no production behavior or assertions were changed. Type checking, architecture, strict OpenSpec validation and the 1000-line gate passed (69 changed source files measured). Generated plugin `lib/` output is excluded from formatting, not source or tests.

## Actual-runtime diagnostic update

The explicit selected Harness was launched with a temporary DSH_HOME, project and Electron userData. Standard plugin installation initially treated the client-only metadata as a plain dependency; adding its standard bundle patch activated it. The first browser load then exposed an ESM/classic-script mismatch. Client builds now register a DSH module factory (matching the selected Harness client preset), and build-time evaluation verifies the actual generated registration and public exports. The separate host entry remains ESM. Authentication checks use the observed HTTP 303 cookie exchange.

Actual DSH workspace/session RPC creation, real isolated Electron extension loading, named navigation, exact selection readback, switching to a newly created session, reload/re-registration and wrong-path rejection without changing selection passed. The captured page still shows the first-run DSH internal-test notice; this is not visual or public-UI acceptance. No model task was submitted. The isolated diagnostic is not the production remote composition or a two-peer transport test.

## Remaining production integration

The extension and guest controller are not yet wired into production remote-runtime registration, managed plugin installation, remote project-root UI or the P2P helper. Task 9.1's standalone extension scope has implementation, unit and actual-client readback evidence; 9.2 remains unchecked. No installed app, credentials, version pointer, release tag or public release was changed.
