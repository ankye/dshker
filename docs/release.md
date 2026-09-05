# Release

Release requires separately built native macOS and Windows packages from the
same Launcher source revision. Each package must prove renderer isolation,
artifact contents, app identity, declared signing status, and startup of an
exact compatible DeepSeek Harness checkout.

A web preview, a template validation result, a source screenshot, or an
unverified local installer is not release evidence. The current public channel
delivers explicitly unsigned installers for manual installation. Signing
identities and certificates remain outside this repository.

## Version and distribution identity

`package.json` is the only Launcher version source. Application metadata,
installer names, release manifests, update comparisons, and the tag gate read
that value instead of maintaining another version constant. A release tag must
be the exact stable semantic version `v${package.json.version}`.

The public update feed is the fixed
[DSHKer GitHub Releases page](https://github.com/ankye/dshker/releases/latest).
The Launcher reads its latest stable release in Electron main and only opens the
exact installer selected for the current supported platform and architecture.
It does not download, install, replace, or restart the application silently.
GitHub Actions artifacts remain build evidence and are not an update feed.

## Readiness gates

`npm run release:readiness` runs every gate in order and stops the release on
the first hard-gate failure. It writes machine-readable evidence to
`.run/release-readiness/latest.json`, which is the artifact reviewers read
instead of scrollback.

Stages, in execution order:

| Stage                | Command                      |
| -------------------- | ---------------------------- |
| `environment-check`  | `npm run environment:check`  |
| `architecture-check` | `npm run architecture:check` |
| `format-check`       | `npm run format:check`       |
| `type-check`         | `npm run type-check`         |
| `unit-tests`         | `npm test -- --run`          |
| `e2e-tests`          | `npm run test:e2e`           |
| `service-smoke`      | `npm run service:smoke`      |
| `visual-smoke`       | `npm run visual:smoke`       |
| `performance-check`  | `npm run performance:check`  |
| `package`            | `npm run package`            |
| `release-verify`     | `npm run release:verify`     |
| `release-smoke`      | `npm run release:smoke`      |

Every stage is a hard gate. The `package` stage builds only the current
platform, so a complete release needs one readiness run per target operating
system; a macOS run never produces Windows evidence.

POSIX shells (macOS and Linux):

```bash
npm ci
npm run release:readiness
```

Windows PowerShell:

```powershell
npm ci
npm run release:readiness
```

Both spellings are identical here because every stage is an npm script. Do not
substitute a shell-specific command chain: the stage list and its evidence file
are the contract.

## Signing Handoff

Signing runs outside this repository. The current build records
`signingStatus: "unsigned-local"` in `release/release-manifest.json`, and the
GitHub Release warning tells users to download and install the package manually.
macOS Gatekeeper or Windows SmartScreen may require an explicit user action.

When signing is introduced:

1. The signing owner applies the Developer ID (macOS) or Authenticode (Windows)
   identity from the credential store. Never commit a `.p12`, `.pfx`, `.cer`, or
   private key to this repository.
2. Packaging records the signed state in each platform manifest before its
   checksum is accepted.
3. The release assembly verifies the signed installer against that manifest and
   the platform checksum before publication.
4. macOS automatic installation is considered only after signing and
   notarization are operational; the current update action remains a system
   browser download.

## GitHub Actions builds

`.github/workflows/quality.yml` verifies every pull request and push to `main`
with the locked dependencies, seed verification, architecture and format gates,
type checks, tests, smoke checks, and both renderer and Electron builds.

`.github/workflows/package.yml` runs for a push to `main`, a `v*` tag, or a
manual dispatch. It first repeats the release-input quality gates, then builds
macOS arm64/x64 DMGs and Windows x64/arm64 NSIS installers independently. Every
run verifies its release metadata and runs the packaged application smoke on its
native runner. It then uploads each installer with `release-manifest.json` and
`checksums.txt` as a 14-day GitHub Actions artifact.
The packaged smoke launch budget is explicit per native runner: 20 seconds on
macOS and 60 seconds on Windows. Timeout and child-process error details are
retained in the diagnostic artifact.

Only a tag run publishes. Before any package job starts, the workflow requires
a stable tag equal to `v${package.json.version}`. After all four platform jobs
succeed, a minimal `contents: write` job downloads the four named artifacts,
requires one DMG and one EXE for each architecture, checks each installer
against its platform manifest and checksum, writes one installer-only
`checksums.txt`, and preserves the four manifests as
`release-manifest-macos-arm64.json`, `release-manifest-macos-x64.json`,
`release-manifest-windows-x64.json`, and `release-manifest-windows-arm64.json`.
It refuses to continue if the tag already
has a GitHub Release, and `gh release create --verify-tag --generate-notes`
creates a public latest Release without clobbering an existing one. Pushes to
`main` and manual dispatches never execute the publishing job.

The embedded Harness seed is generated during each GitHub Actions run from
`resources/bundled-seed/source.json`. That file pins the public HTTPS remote,
branch, and complete Git revision. The 123MB generated bundle remains ignored,
so an Actions checkout never reuses an untracked local seed.

## Notarization Handoff

Notarization applies to macOS only and happens after signing. The current
unsigned public package is not notarized.

1. The signing owner submits the signed `.dmg` to Apple with `notarytool` using
   credentials held outside this repository.
2. On acceptance, the owner staples the ticket to the artifact.
3. Confirm `spctl --assess --type install <artifact>` accepts the stapled
   artifact on a machine that never built it.
4. Record the resulting `notarizationStatus` in the release manifest.

Windows has no notarization step; its manifest keeps
`notarizationStatus: "not-applicable-local"`.

## Rollback

Rollback never patches or replaces assets in an existing GitHub Release.

1. Identify the last known-good release and record the affected release without
   changing its assets.
2. Restore or fix the known-good source on a new commit, increment the version in
   `package.json`, and record the previous version in the new release manifest.
3. Run both platform gates again and publish a new exact tag. Do not reuse a tag,
   version, installer, checksum, or manifest from the affected release.
4. Confirm the new GitHub Release is latest and that Settings resolves the new
   platform asset before declaring rollback complete.
