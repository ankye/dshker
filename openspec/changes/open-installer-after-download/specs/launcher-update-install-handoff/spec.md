## Purpose

Defines the user-visible handoff from a completed Launcher update download to the platform's interactive installer, including graceful Launcher shutdown and explicit failure behavior.

## ADDED Requirements

### Requirement: Explicit update downloads open the selected interactive installer

After a user explicitly starts downloading an available update, the Launcher SHALL open the exact selected macOS or Windows release asset with the operating system's registered handler only after the complete file has been written. The Launcher SHALL NOT invoke unattended installation, replace itself in-process, or relaunch itself as part of this handoff.

#### Scenario: A Windows installer is downloaded successfully
- **WHEN** the explicit update download finishes and the operating system accepts the open request for the selected Windows installer
- **THEN** the selected `.exe` is opened by its registered handler
- **AND** the Launcher proceeds through its normal graceful quit lifecycle
- **AND** the user remains responsible for confirming and completing the visible installer

#### Scenario: A macOS installer is downloaded successfully
- **WHEN** the explicit update download finishes and the operating system accepts the open request for the selected macOS disk image
- **THEN** the selected `.dmg` is opened by its registered handler
- **AND** the Launcher proceeds through its normal graceful quit lifecycle
- **AND** the user remains responsible for confirming and completing installation

#### Scenario: The operating system rejects the open request
- **WHEN** opening the completed installer returns an error
- **THEN** the Launcher remains running and reports a typed, localized handoff error
- **AND** the completed installer remains at its original download destination
- **AND** the Launcher does not silently retry, choose another asset, or quit

#### Scenario: A Launcher-owned mutation is already active
- **WHEN** a managed DSH, workspace, or plugin-catalog Git operation is active before download starts
- **THEN** the Launcher refuses the download-and-quit operation with a typed busy error
- **AND** it does not start downloading or quit

#### Scenario: A managed mutation starts before installer handoff
- **WHEN** a managed DSH, workspace, or plugin-catalog Git operation becomes active while the installer is downloading
- **THEN** the Launcher preserves the completed installer without opening it or quitting
- **AND** it reports a typed handoff-busy state that permits an explicit retry after the mutation ends

#### Scenario: A download is incomplete or no longer belongs to the current update
- **WHEN** a transfer has not completed or its update generation is no longer current
- **THEN** the Launcher does not open the installer or begin its update-triggered quit

### Requirement: Launcher shutdown preserves the installer and cleans owned runtime state

After a successful installer handoff, the Launcher SHALL use its normal graceful application quit lifecycle so Launcher-owned runtime children and resources are cleaned up. It SHALL preserve the downloaded installer and user data required by the installation.

#### Scenario: Graceful handoff cleanup completes
- **WHEN** the OS accepts the installer open request
- **THEN** the Launcher runs its ordinary application shutdown cleanup
- **AND** the downloaded installer remains available for the platform installer
- **AND** no partial-download file or Launcher-owned child process is left running
