## 1. Artifact builder

- [x] 1.1 Add an explicit-target standalone archive builder that invokes the existing Go helper, emits the executable, version metadata, manifest, and SHA256 checksum, and verify it with a clean temporary output for one macOS and one Linux target.
- [x] 1.2 Add package scripts for all six standalone targets and verify the explicit target scripts and all-target mode reject unsupported target names before writing output.
- [ ] 1.3 Add focused archive/manifest/checksum verification tests, including tampering and wrong-target cases, and verify they pass on the Linux CI runner.

## 2. Installers

- [ ] 2.1 Implement the POSIX installer with explicit version/target resolution, strict HTTPS downloads, checksum and manifest verification, temporary staging, atomic replacement, and no implicit configuration; verify success and mismatch/refusal scenarios with a shell test harness.
- [ ] 2.2 Implement the Windows PowerShell installer with the same explicit inputs, verification, staging, and replacement guarantees; verify syntax and checksum refusal in PowerShell on the Windows CI runner.
- [x] 2.3 Add installer help, upgrade, uninstall, PATH, and first-run guidance without editing shell profiles or enabling autostart implicitly; verify every documented command matches the scripts.

## 3. Release integration

- [ ] 3.1 Add a standalone CLI build matrix to `.github/workflows/package.yml`, upload per-target archives and checksums, and verify CI refuses missing or mislabeled CLI artifacts.
- [x] 3.2 Extend release assembly and publication to include only verified standalone assets alongside the existing Launcher assets, preserving the existing prerelease/stable policy; verify a dry-run asset list contains all six targets.
- [ ] 3.3 Add release-readiness evidence for standalone artifacts and installer checksums; verify `npm run release:readiness` fails when a required CLI asset or manifest is absent.

## 4. Documentation and quality

- [x] 4.1 Document standalone installation and headless first-run configuration in `README.md`, `README.zh-CN.md`, and `docs/release.md`; verify links, target names, and commands against the implementation.
- [x] 4.2 Add the user-visible change to `CHANGELOG.md` and an Agent Note under `.agents/notes/`; verify the note records validation tier and unresolved platform evidence.
- [ ] 4.3 Run focused Go, installer, archive, formatting, architecture, and release-readiness checks; record macOS/Linux and Windows evidence separately and do not claim unrun platform evidence.
