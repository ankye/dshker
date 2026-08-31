# Release

Release requires separately built native macOS and Windows packages from the
same launcher source revision. Each package must prove renderer isolation,
artifact contents, app identity, signature, and startup of an exact compatible
DeepSeek Harness checkout.

An unsigned development build, a web preview, a template validation result, or
a source screenshot is not release evidence. Signing identities and certificates
remain outside this repository.

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

Signing runs outside this repository. The build produces an unsigned local
artifact and records `signingStatus` in `release/release-manifest.json`.

1. Run `npm run package` (or `npm run dist`) and confirm the manifest reports
   `signingStatus: "unsigned-local"`.
2. Hand the artifact and its manifest `sha256` to the signing owner.
3. The signing owner applies the Developer ID (macOS) or Authenticode (Windows)
   identity from the credential store. Never commit a `.p12`, `.pfx`, `.cer`, or
   private key to this repository.
4. Re-run `npm run release:verify` against the signed artifact and confirm the
   recorded checksum changed exactly once.

A release whose manifest still reports `unsigned-local` is a development build
and must not be published.

## Notarization Handoff

Notarization applies to macOS only and happens after signing.

1. The signing owner submits the signed `.dmg` to Apple with `notarytool` using
   credentials held outside this repository.
2. On acceptance, the owner staples the ticket to the artifact.
3. Confirm `spctl --assess --type install <artifact>` accepts the stapled
   artifact on a machine that never built it.
4. Record the resulting `notarizationStatus` in the release manifest.

Windows has no notarization step; its manifest keeps
`notarizationStatus: "not-applicable-local"`.

## Rollback

Rollback republishes the previous known-good version rather than patching a bad
artifact in place.

1. Identify the last release whose manifest recorded a signed, verified, and
   smoke-tested artifact.
2. Set `rollback.previousVersion` and `rollback.notes` in the new
   `release/release-manifest.json` so the record states what was withdrawn and
   why.
3. Restore the previous artifact as the published download, and withdraw the bad
   version from the distribution point.
4. Re-run `npm run release:smoke` against the restored artifact to prove the
   rollback target still launches.
5. Do not reuse the withdrawn version number. Publish the fix under a new
   version so `.run/release-readiness/latest.json` and the release manifest stay
   one-to-one with a distinct artifact.
