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

### Requirement: Local resources are confined to declared desktop assets

The launcher SHALL serve renderer resources through its trusted local application protocol and only from declared immutable Launcher resources. It SHALL reject traversal, encoded path escapes, undeclared files, and navigation to arbitrary local files.

#### Scenario: Resource request escapes its declared asset set

- **WHEN** a renderer resource request names an undeclared or escaping path
- **THEN** the launcher rejects the request before reading a file
- **AND** it does not translate the request to `file://` or network access
