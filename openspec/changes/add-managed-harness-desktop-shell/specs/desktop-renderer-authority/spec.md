## Purpose

Defines the renderer authority boundary: what the trusted renderer may receive from Electron main, and which local resources it may load.

## ADDED Requirements

### Requirement: Renderer receives only a typed desktop surface

The renderer SHALL run with context isolation and sandboxing and receive only named typed preload operations. It SHALL not receive Node primitives, arbitrary IPC, raw filesystem paths, shell execution, Git execution, child-process control, native-dialog authority, executable paths, or secret values.

#### Scenario: Renderer attempts an unsupported operation

- **WHEN** renderer code requests an operation outside the documented preload surface
- **THEN** Electron main rejects it before side effects occur
- **AND** the renderer cannot obtain a generic IPC or Node escape

#### Scenario: An untrusted frame sends a known channel name

- **WHEN** a message arrives on a documented channel from a sender that is not the trusted renderer
- **THEN** main rejects it as an invalid sender
- **AND** no managed service method runs

#### Scenario: Console activity is pushed to the renderer

- **WHEN** the Launcher appends a console record for an operation, a preparation step, or the DSH Web child
- **THEN** main pushes exactly the appended service-owned entries on the one named main-to-renderer console channel
- **AND** the channel accepts no renderer-supplied payload and grants no filesystem, process, or dialog authority

### Requirement: Run rendering controls use a bounded typed surface

The preload surface SHALL expose only named typed operations for reading and selecting a supported Run page zoom and for reading the safe rendering observation. Electron main SHALL validate the trusted renderer sender, the attached loopback guest identity, the persisted preference record, and the selected zoom against the fixed supported set before applying it. A guest `before-input-event` listener SHALL recognize only `Cmd`/`Ctrl` plus `+`, `-`, or `0` for Run zoom and SHALL synchronize the resulting effective value with the trusted renderer. It SHALL NOT expose arbitrary `webContents`, script execution, navigation, developer-tools, device-scale-factor, or input-event authority.

The diagnostic result SHALL contain only host and guest device-pixel ratios, effective guest zoom factor, guest `visualViewport.scale`, Electron and Chromium versions, current display color space, GPU compositing status, and explicit unavailable states. It SHALL NOT contain a guest URL, query, cookie, storage value, request header, credential, or token.

#### Scenario: Renderer requests an unsupported zoom value

- **WHEN** the trusted renderer submits a value outside 80, 90, 100, 110, 125, 150, 175, and 200 percent
- **THEN** Electron main rejects the typed operation before changing any guest or preference record
- **AND** it does not clamp, round, or substitute the requested value

#### Scenario: Attached guest emits a zoom accelerator

- **WHEN** the attached loopback guest emits a documented Run zoom accelerator
- **THEN** Electron main selects the corresponding fixed step and reports the effective guest zoom to the trusted toolbar
- **AND** other guest input does not cross the preload boundary or grant a generic keyboard-event channel

#### Scenario: Renderer requests rendering diagnostics

- **WHEN** the trusted renderer requests the current Run rendering observation
- **THEN** Electron main returns only the declared secret-free fields for the validated attached guest and display
- **AND** it rejects an unknown or detached guest identity

### Requirement: Launcher update authority remains in Electron main

The preload surface SHALL expose only named typed operations to read update state, request a check, request the current validated installer download, and receive update-state changes. Electron main SHALL own the fixed DSHKer GitHub release endpoint, network request, semantic-version comparison, platform and architecture selection, retained installer URL, and operating-system browser call. The renderer SHALL NOT supply a repository, endpoint, release URL, asset URL, platform, architecture, HTTP options, or filesystem destination.

An installer download request SHALL succeed only while Electron main retains one update-available observation from the current successful check. Electron main SHALL validate the trusted renderer sender and the retained HTTPS GitHub asset URL before opening it. A failed or superseded check SHALL withdraw download authority; it SHALL NOT reuse a stale asset URL.

#### Scenario: Renderer checks the fixed release source

- **WHEN** the trusted renderer invokes the named update-check operation
- **THEN** Electron main requests only the fixed DSHKer latest-release endpoint and returns a typed update state
- **AND** the renderer receives no general network client or arbitrary external-navigation capability

#### Scenario: Renderer attempts to choose a download URL

- **WHEN** renderer code supplies a URL, repository, platform, architecture, or other unsupported update input
- **THEN** Electron main rejects it before network or browser side effects occur
- **AND** it does not translate the input into a supported request

#### Scenario: Download observation is no longer current

- **WHEN** the renderer requests the installer after the retained update-available observation has failed or been replaced
- **THEN** Electron main rejects the download request
- **AND** it does not open the previous asset URL

### Requirement: Local resources are confined to declared desktop assets

The launcher SHALL serve renderer resources through its trusted local application protocol and only from declared immutable Launcher resources. It SHALL reject traversal, encoded path escapes, undeclared files, and navigation to arbitrary local files.

#### Scenario: Resource request escapes its declared asset set

- **WHEN** a renderer resource request names an undeclared or escaping path
- **THEN** the launcher rejects the request before reading a file
- **AND** it does not translate the request to `file://` or network access
