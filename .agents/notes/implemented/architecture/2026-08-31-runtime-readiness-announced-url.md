# Runtime readiness comes from the child's announced URL

## Context

The approved change describes a generation-fenced private IPC bridge between the
Launcher and a Harness child started under a named `desktop` profile. That design
assumed a companion Harness change (task 1.1).

Inspecting the Harness checkout showed that companion does not exist.
`$DSH_HOME/profiles/desktop` is an empty scaffold whose `cordis.patch.yml` is
`[]`, `apps/cli/src` exposes no descriptor flag, and there is no child IPC
counterpart. Meanwhile `runtime-descriptor.ts` and `runtime-supervisor.ts` were
present with tests but had no production caller: `main.ts` wired
`ManagedHarnessWebRuntimeSupervisor` from `harness-web-runtime.ts`, which spawns
the ordinary `dsh web --no-open`. The proposal itself already required no Harness
change, so the bridge spec contradicted the proposal it lived under.

The bridge spec was also an orphan: `desktop-harness-client-bridge` was never
declared in the proposal's capability list, which is how it drifted out of
agreement with everything around it.

Separately, the run page loaded a hardcoded `http://127.0.0.1:3080` that was
connected to nothing the launcher had started.

## Decision

For 0.1.0 the launcher starts the standard `dsh web --no-open` command and takes
readiness from exactly one signal: the `dsh web: <url>` line the child prints.

The launcher parses that line, accepts it only when the scheme is http(s) and the
host is loopback, and preserves the URL unmodified. It never predicts a port or
reconstructs the address. `LauncherHarnessLaunchView` therefore carries the URL on
its `running` variant, and `running` is reachable only after the announcement;
a successful spawn leaves the runtime `starting`.

The orphan capability is gone. Its runtime requirements moved into
`harness-runtime-supervision`, and its renderer-authority and local-resource
requirements became `desktop-renderer-authority`, now declared in the proposal.
The rejected private-IPC alternative is recorded in `design.md`, which is where
`openspec/config.yaml` requires rejected alternatives to live.

The 1848 lines of unwired `runtime-descriptor` / `runtime-supervisor` code and
tests were deleted rather than annotated. A first version should not ship dead
code for a transport it does not implement; Git history keeps the implementation
for whoever takes up the cross-repository change.

## Consequences

Two real defects disappear rather than one. `dsh web` chooses its own port, so the
hardcoded 3080 was wrong whenever the default was taken; and the announced URL may
embed a session credential, so a rebuilt address would have failed to
authenticate even on the right port. Binding the page to the announced URL fixes
both, and withdrawing pages when the process stops prevents a frame pointing at a
dead or recycled address.

The cost is weaker proof: an announced URL shows a server is listening, not that
the expected worktree and profile became active. That proof needs the deferred
bridge, and task 1.3 stays blocked until a real end-to-end launch exists.

## Evidence

`npm test -- --run` → 40 files, 173 tests passing, including 7 new cases pinning
the announcement parser (credential preservation, LAN-suffix handling, and
rejection of non-loopback hosts, non-http schemes, and prose mentions).
`npm run type-check`, `architecture:check`, `format:check`, `visual:smoke`,
`service:smoke`, and `seed:verify` pass;
`node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json` reports
`ok: true`. `tools/visual-smoke.mjs` now asserts `runtime.no-hardcoded-url` so the
guessed port cannot return unnoticed.

No real clone-through-stop launch has been run, so announced-URL readiness is
proven at unit level only.

## Follow-up: packaged-app smoke instrumentation

Running the full readiness pipeline surfaced a second gap. `release-smoke` failed
with an empty payload because the launcher had never adopted the workspace
template's `electron/main/smoke.ts`, so the packaged artifact had no way to report
renderer evidence. Two smaller defects sat underneath it:

- `tools/release-smoke.mjs` looked only in `release/mac`, but electron-builder
  appends the arch for every non-x64 target, so an Apple Silicon build lands in
  `release/mac-arm64` and its executable was never found.
- `APP_METADATA.appId` is the short internal `dsh-launcher`, while the release
  manifest records the installed bundle id `com.ankye.dsh-launcher`. The evidence
  payload now reports `bundleId`, which is the identity the manifest asserts.

The launcher's smoke walk is click-driven rather than hash-driven, because shell
route state lives in memory and exposes no URL route; a hash walk would have
passed without changing the view. Smoke mode registers the real IPC surface —
the shell cannot mount without it — but points every managed root at a
disposable temp directory and skips the bundled-Harness bootstrap, so collecting
release evidence never touches the user's real `~/.dshlauncher` or clones a
checkout.

`npm run release:readiness` now passes all 12 stages on macOS arm64. The packaged
artifact proves shell mount, all six routes, preload presence, a non-blank
multi-colour first frame, and zero renderer errors. Signing, notarization, and a
Windows build remain outstanding.
