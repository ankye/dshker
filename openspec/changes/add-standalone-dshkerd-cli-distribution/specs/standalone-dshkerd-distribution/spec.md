## Purpose

Provide a verifiable, headless DSHKer installation path for servers and remote peers that do not need or cannot run the Electron Launcher.

## ADDED Requirements

### Requirement: Standalone artifacts are published per target

The release pipeline SHALL publish one standalone `dshkerd` archive for each supported target: macOS arm64, macOS x64, Windows arm64, Windows x64, Linux arm64, and Linux x64. Each archive MUST contain only the target executable, a version file, and the artifact manifest needed for verification.

#### Scenario: Release contains all CLI targets

- **WHEN** a version tag passes the package workflow
- **THEN** the GitHub Release contains six uniquely named `dshkerd` archives and no archive is mislabeled for another operating system or architecture

#### Scenario: Archive integrity is verifiable

- **WHEN** an operator downloads an archive and its published checksum
- **THEN** the checksum matches the archive bytes and the manifest identifies the same version, target, filename, and executable digest

### Requirement: POSIX one-command installer is explicit and safe

The POSIX installer SHALL require an explicit release version or an explicit documented release channel, download only the matching target archive and checksum from the official release, verify SHA256 before installation, refuse unsupported platforms or architectures, and install without changing coordinator, trust, pairing, or autostart configuration.

#### Scenario: Explicit version installs successfully

- **WHEN** a macOS or Linux user runs the installer with a valid version and an installation directory they can write
- **THEN** the matching `dshkerd` executable is installed atomically, marked executable, and `dshkerd --version` succeeds

#### Scenario: Checksum mismatch refuses installation

- **WHEN** the downloaded archive or checksum does not match the expected digest
- **THEN** the installer exits non-zero, removes its temporary files, and leaves the existing installed executable unchanged

#### Scenario: Unsupported target is refused

- **WHEN** the installer detects an unsupported OS or CPU architecture
- **THEN** it exits non-zero before downloading or modifying any installation path

### Requirement: Windows one-command installer is explicit and safe

The Windows installer SHALL require an explicit release version or an explicit documented release channel, download only the matching Windows archive and checksum from the official release, verify SHA256 before installation, and install without changing coordinator, trust, pairing, or autostart configuration.

#### Scenario: Windows installation succeeds

- **WHEN** a Windows user runs the installer with a valid version and writable installation directory
- **THEN** the matching `dshkerd.exe` is installed atomically and `dshkerd.exe --version` succeeds

#### Scenario: Windows checksum mismatch refuses installation

- **WHEN** the downloaded Windows archive or checksum does not match the expected digest
- **THEN** the installer exits non-zero and does not replace an existing executable

### Requirement: Installation guidance separates binary setup from host configuration

The README documentation SHALL show POSIX and Windows installation commands, upgrade and uninstall commands, the supported target matrix, and the required explicit next steps for `serve`, `service configure`, `pair`, `connect`, `dsh start|stop`, and `autostart`. It MUST state that installing the binary does not configure or connect a host.

#### Scenario: Operator follows first-run guidance

- **WHEN** an operator completes installation and follows the documented sequence
- **THEN** they can verify the binary, configure the explicitly supplied service and trust values, start the headless core, and inspect status without installing Electron

#### Scenario: Documentation does not imply hidden defaults

- **WHEN** the documented configuration is incomplete or a required value is unavailable
- **THEN** the operator is directed to the typed refusal and required explicit command rather than an inferred endpoint, credential, or fallback path
