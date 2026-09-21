# Standalone dshkerd CLI distribution

## Scope

The repository now treats the headless Go core as a separate distribution channel from the Electron Launcher. Six target archives are built from the same `dshkerd` source used by the embedded helper, and the package workflow validates and publishes them beside the desktop installers.

## Installation contract

- macOS/Linux use `tools/install-dshkerd.sh` and Windows uses `tools/install-dshkerd.ps1`.
- Installers require an explicit stable version, download only the matching official GitHub Release asset, verify the archive checksum and embedded manifest, then atomically replace a user-local binary.
- Installers do not configure coordinator endpoints, copy credentials, create pairings, edit PATH, or enable autostart. Those remain explicit `dshkerd` commands.
- The README one-liner is version-pinned and points at the same repository tag as the release assets.

## Validation

- `npm run test:dshkerd-distribution` passed on macOS arm64, including archive/manifest checks, unsupported-target refusal, and tamper detection.
- `npm run build:dshkerd -- --output-dir <temporary-dir> --overwrite` built all six targets and produced the expected archives and combined manifest.
- Release assembly was exercised with six per-target inputs and produced all six archives, the combined checksum/manifest pair, and both installers.
- Full renderer/unit suite: 164 files and 1,436 tests passed.
- Go core suite `go test ./internal/... ./cmd/...` passed.
- Changed-file Prettier, `git diff --check`, `npm run architecture:check`, `npm run type-check`, and strict OpenSpec validation passed.

## Not verified

Windows PowerShell execution and GitHub Actions release publication still require the next tagged CI run; no Windows runtime evidence is claimed locally.
