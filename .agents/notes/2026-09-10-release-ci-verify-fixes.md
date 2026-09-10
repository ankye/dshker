# Release CI verify fixes — 2026-09-10

## Root causes

Two failures showed up only on CI runners, because the P2P work had never been
exercised in a clean checkout before the v0.1.26 tag push.

1. electron/main/p2p/packaging.test.ts read build/p2p unconditionally.
   That directory is produced only by tools/build-peer-helper.mjs (run by each
   dist:* script); CI verify steps never build the per-platform Go helper, so
   the readdir threw ENOENT on a clean runner. The dir-name convention check is
   only meaningful when a helper has actually been built.
2. src/foundation/appMetadata.ts only guarded desktopApi, not
   desktopApi.bootstrap. Tests (e.g. P2PNetworkAccountPanel.test.ts) stub
   window.dshLauncher with only the p2pManagement capability; the pairing
   panel in the mounted tree calls useLauncherShell, whose onMounted
   void initialize() then rejected with a raw TypeError from
   undefined.getInfo(). Locally the rejection landed after the test finished
   (vitest reported it as an unhandled error, exit 0); on CI it landed inside
   the running test and failed it. Missing bootstrap is exactly the
   "bridge unavailable" condition and now returns a typed
   bootstrap.bridge_unavailable result instead of throwing.

## Fixes

- src/foundation/appMetadata.ts: guard !desktopApi.bootstrap in
  getBootstrapInfo, returning apiFail(bootstrap.bridge_unavailable, ...).
- electron/main/p2p/packaging.test.ts: existsSync(build/p2p) short-circuit
  in the directory-name test; the three package.json contract tests always run.

## Verification

Both previously failing files pass locally; full npm test -- --run re-run to
confirm no regressions and that the "Errors 1" unhandled-error noise is gone.
