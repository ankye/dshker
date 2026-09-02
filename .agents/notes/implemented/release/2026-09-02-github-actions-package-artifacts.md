# GitHub Actions package artifacts

## Context

The Launcher had local packaging scripts and release metadata, but the GitHub
repository did not verify changes or build installers from tagged source.

## Decision

GitHub Actions verifies pull requests and `main` with the same repository
quality gates used locally. A separate tag/manual workflow builds an arm64
macOS DMG and x64 Windows NSIS installer, then uploads each installer with its
checksum and release manifest as a short-lived workflow artifact.

The build first generates the ignored Harness Git bundle from a tracked source
specification. CI clones the declared public HTTPS remote, checks out its exact
SHA on a temporary branch, and verifies the generated resource before any
application packaging begins.

## Consequences

The workflow never creates a GitHub Release from an unsigned package. Code
signing and macOS notarization remain external credential-owned steps; only
after those inputs are configured may a separate publishing workflow release a
signed artifact.
