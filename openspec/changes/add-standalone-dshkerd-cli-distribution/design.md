## Context

See `proposal.md` for motivation. `tools/build-peer-helper.mjs` already cross-compiles the Go-owned `dshkerd` binary into `build/p2p/<target>/` for the six desktop targets and writes an executable manifest. The existing package workflow verifies that embedded binary, but only uploads Electron installers. The CLI distribution must reuse that Go entry point without importing Electron code or changing its parent-bootstrap mode.

## Goals / Non-Goals

**Goals:**

- Produce deterministic, target-labeled archives and SHA256 metadata for the existing `dshkerd` binary.
- Add official-release POSIX and PowerShell installers that use explicit versions and verify bytes before replacement.
- Keep CLI installation, Launcher installation, and Launcher update metadata separate.
- Make the README sequence sufficient for a headless server operator to continue with explicit service and pairing configuration.

**Non-Goals:**

- No new network protocol, coordinator, relay, pairing, or credential behavior.
- No automatic endpoint discovery, credential copying, autostart enablement, or implicit installation directory.
- No Electron runtime, Node.js dependency, package-manager repository, code signing, or installer elevation requirement in this change.

## Decisions

1. **Reuse the existing Go build entry point.** The archive builder invokes `tools/build-peer-helper.mjs` with an explicit target and packages only the generated `dshkerd` executable. This keeps the standalone and embedded cores byte-identical for a target; alternatives such as a second Go command or an Electron wrapper would create drift.

2. **Use release archives plus shell/PowerShell installers.** Archives are portable and inspectable, while small installers provide one-command setup. The installer takes `--version`/`-Version` explicitly and accepts `DSHKERD_INSTALL_DIR`/`-InstallDir` explicitly or uses the documented per-user bin directory; it never writes system locations without permission. Homebrew, winget, deb/rpm, and signed native packages remain follow-up distribution channels.

3. **Verify before atomic replacement.** The installer downloads to a temporary directory, checks the archive against the release checksum, checks the executable against the embedded manifest, extracts to a temporary path, then renames into place. Any failure leaves the previous executable untouched.

4. **Keep release assembly explicit.** A separate CLI matrix uploads artifacts named `dshkerd-<os>-<arch>-<version>`, while the publish job passes those files to `gh release create` alongside existing Launcher assets. The Launcher release manifest is not changed to describe CLI archives.

5. **Use a stable checksum format.** Each archive gets a line in `dshkerd-checksums.txt` with the archive SHA256, and each archive includes `dshkerd-manifest.json` containing version, target, executable filename, and executable SHA256. The installer fails when any required field is absent or inconsistent.

## Risks / Trade-offs

- [Risk] A raw `curl | sh` pipeline can hide failures or be copied from an untrusted mirror → the documented command downloads a pinned script from the tagged official repository and passes an explicit version; the script uses strict mode, HTTPS, checksum verification, and a temporary directory. A downloaded local script invocation is also documented for auditability.
- [Risk] GitHub asset naming or release visibility differs for prereleases → the installer requires an explicit version and uses the GitHub release API/asset names; it does not silently switch to latest or stable.
- [Risk] User-local PATH is not configured → the installer prints the exact installed path and a shell-specific PATH command, but does not edit shell profiles implicitly.
- [Risk] Windows archive extraction or antivirus scanning delays atomic rename → the installer stages in a temporary directory and reports the exact replacement error without deleting the existing binary.

## Migration Plan

1. Add archive/checksum/installer scripts and focused tests.
2. Add the standalone CLI matrix to CI and assemble assets only after the existing desktop matrix and verification pass.
3. Update the README and release notes; publish the next tagged prerelease with CLI assets first.
4. If the CLI job fails, existing Launcher artifacts remain publish-blocked; no existing installed Launcher is changed.
