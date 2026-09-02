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

The preparation step verifies the Git bundle and its `master` reference while
the selected Git executable is available. Later packaging verifies the staged
manifest and resource hashes only; it must not hard-code a POSIX Git path, so
the same tagged workflow can build on Windows.

Each installer build records its complete command output. A failed build emits
its final diagnostics as a check annotation and uploads the complete log with
the workflow artifacts, so a hosted-runner difference remains diagnosable.

## Consequences

The workflow never creates a GitHub Release from an unsigned package. Code
signing and macOS notarization remain external credential-owned steps; only
after those inputs are configured may a separate publishing workflow release a
signed artifact.
