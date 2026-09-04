# Launcher GitHub Release updates

## Context

DSHKer Launcher previously exposed GitHub Actions package artifacts as its installation entry. Those artifacts expire, are tied to individual workflow runs, and cannot serve as a stable application update source. The visible application version also had a separate shared constant that could drift from installer and release metadata.

The current macOS and Windows installers are unsigned. They can be distributed with an explicit warning and checksum, but the application cannot safely replace itself or claim a signed native auto-update flow.

## Decision

The root `package.json` is the only Launcher version source. Shared metadata, installer naming, release metadata, update comparison, and the tag gate derive the same value. A publishing tag is a stable semantic version and must equal `v${package.json.version}` exactly.

The package workflow continues to produce short-lived arm64 macOS and x64 Windows Actions artifacts for `main` pushes and manual dispatches. A tag run publishes only after both package jobs succeed. The publishing job has the workflow's only `contents: write` grant. It downloads the two exact named artifacts, requires one installer for each platform, verifies each against its platform manifest and checksum, writes a combined installer checksum file, retains platform-named manifests, and refuses to overwrite an existing GitHub Release.

Electron main owns update discovery from the fixed DSHKer latest-release API. The renderer can request only named typed state, check, and download actions; it cannot choose a repository, endpoint, platform, architecture, or URL. Release parsing accepts a stable semantic version and one exact installer for the running supported platform. Semantic comparison advertises only a higher version as update available; an equal or older accepted release is up to date. Missing, duplicate, malformed, unsupported, or unreachable release data is a failed state rather than a reason to choose another asset or feed.

Startup performs the check after the window is usable. Only an available update creates a passive notice. Failures remain visible in Launcher Settings for explicit retry and do not interrupt startup.

Download opens the exact retained HTTPS GitHub asset in the operating-system browser. The Launcher does not download to an application-controlled path, install, replace, or restart itself. Release and Settings copy identify the packages as unsigned and require manual installation. A signed and notarized macOS auto-update path requires a separate design and release change.

## Consequences

- GitHub Releases, not Actions artifacts, provide the stable update feed and installation entry.
- A version change is made once in `package.json`; a mismatched tag blocks both platform packaging and publication.
- A malformed Release cannot silently downgrade platform or architecture safety.
- Public releases currently optimize availability rather than warning-free installation; Gatekeeper and SmartScreen guidance remains part of the user handoff.
- Publishing is additive. Correcting a release requires a new version and tag instead of replacing existing assets.
