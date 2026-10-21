## Purpose

Ensures commands launched inside DSH receive the same usable command search paths as the desktop user's environment, including PATH entries configured by an interactive shell.

## ADDED Requirements

### Requirement: DSH inherits the user's command search path across platforms
When DSHKer starts DSH, it MUST preserve the PATH inherited by DSHKer and the bundled runtime path. On macOS and Linux it MUST also resolve and include the configured login-interactive shell PATH. On Windows it MUST preserve the inherited process PATH, including user-level entries. The resolved PATH MUST be scoped to DSH and its descendants; resolving it MUST NOT mutate the Launcher's process environment or system configuration.

#### Scenario: Desktop launch on macOS or Linux
- **WHEN** DSHKer is opened by the desktop and starts DSH
- **THEN** DSH and commands it launches can resolve executables present in the user's configured login-interactive shell PATH as well as executables from DSHKer's inherited and bundled runtime paths

#### Scenario: Launch on Windows
- **WHEN** DSHKer starts DSH on Windows with user-level entries in its inherited PATH
- **THEN** DSH and commands it launches can resolve those entries, and DSHKer does not start a shell solely to reconstruct Windows PATH

#### Scenario: Windows inherited PATH is unavailable
- **WHEN** the Windows process has no inherited PATH
- **THEN** DSHKer refuses to start DSH with a typed launch error instead of starting with only the bundled runtime path

#### Scenario: Windows inherited PATH ends with one terminator
- **WHEN** the Windows process has a usable inherited PATH ending in one semicolon
- **THEN** DSHKer omits that terminal delimiter from the child PATH and starts without an empty search entry
- **AND** a leading, interior, or repeated terminal empty entry still produces a typed launch error rather than searching the current working directory

#### Scenario: Login-shell PATH cannot be resolved
- **WHEN** a POSIX login-interactive shell is unavailable, exits unsuccessfully, times out, or returns an invalid PATH
- **THEN** DSHKer refuses to start DSH with a typed launch error and does not substitute a guessed, partial, or system-only PATH

#### Scenario: Configured POSIX shell is unsupported
- **WHEN** the configured login shell is not one of the explicitly supported shells
- **THEN** DSHKer refuses to start DSH with a typed launch error instead of trying another shell

#### Scenario: PATH composition preserves other inherited environment
- **WHEN** DSHKer adds its bundled runtime and resolved command search paths to DSH's launch environment
- **THEN** every non-PATH environment value inherited by the DSH child remains unchanged, and the Launcher's own environment remains unchanged
