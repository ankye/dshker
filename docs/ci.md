# CI

## Source checks

Run these on both macOS and Windows. The npm spellings are identical across
POSIX shells and Windows PowerShell.

```bash
npm ci
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run seed:verify
npm run build
npm run build:electron
```

Run the workspace framework gate from the `desktop_workspace` repository root:

```bash
node tools/validate-desktop-app.mjs --app apps/dsh-launcher --json
```

## Release jobs

Release jobs run `npm run release:readiness`, which executes every source check
plus packaging, metadata verification, and a packaged-app smoke test, then
writes evidence to `.run/release-readiness/latest.json`.

The `package` stage builds the current-platform artifact only. A macOS runner
therefore produces no Windows evidence and a Windows runner produces no macOS
evidence, so release requires one readiness job per target platform and both
must pass on the same source revision.

Release jobs must fail — never warn or skip — when a platform's required
evidence is unavailable. Signing and notarization are handled by the owners
described in [release.md](release.md); CI does not hold signing credentials.
