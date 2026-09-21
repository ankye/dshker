## Why

Server and remote-peer operators need to run DSHKer without installing the Electron Launcher or a graphical session. The repository already builds and tests the headless `dshkerd` core, but the release currently hides it inside desktop installers, so a machine reachable only over SSH has no supported one-command installation path.

## What Changes

- Publish standalone `dshkerd` archives for every supported OS/architecture alongside the Launcher release.
- Add a checksum-verified POSIX installer that downloads an explicitly selected release version and installs only the CLI binary.
- Add a Windows PowerShell installer with the same explicit-version and checksum guarantees.
- Add package scripts and CI jobs that build, validate, checksum, and upload the standalone artifacts without changing the Electron installer flow.
- Document installation, upgrade, uninstall, first-run configuration, and headless pairing commands in both READMEs.
- Keep server URL, trust key, pairing, and autostart choices explicit; the installer must not invent configuration or silently enable a service.

## Capabilities

### New Capabilities

- `standalone-dshkerd-distribution`: Build, verify, publish, and install the headless CLI as a separate product artifact.

### Modified Capabilities

- None.

## Impact

- `networking/cmd/dshkerd` remains the runtime source of truth; no Electron dependency is added.
- `tools/` gains reproducible archive, checksum, and installer helpers.
- `.github/workflows/package.yml` gains a standalone CLI matrix and release asset assembly.
- `package.json`, `README.md`, `README.zh-CN.md`, `docs/release.md`, and `CHANGELOG.md` are updated.
- Existing Launcher artifacts and updater channels remain unchanged.
