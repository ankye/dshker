## Purpose

Defines the Launcher-owned directory model so managed Harness revisions, downloaded plugin sources, downloaded Agent preset sources, and Launcher settings remain isolated without replacing the user's Harness home.

## ADDED Requirements

### Requirement: Launcher defaults avoid first-run root registration

The launcher SHALL create its private Harness, Plugins, Presets, and Settings roots at `~/.dshlauncher` before rendering the first managed workspace screen. It SHALL not require a four-directory registration flow. The Settings root MAY be explicitly relocated after setup; a path selected for relocation SHALL pass the same canonicality, containment, and native-home exclusion checks.

#### Scenario: User opens Launcher for the first time

- **WHEN** no Launcher registry exists
- **THEN** the launcher creates and persists its documented platform-default locations
- **AND** it opens the clone/workspace surface without asking the user to select root directories

#### Scenario: Settings relocation is unsafe

- **WHEN** a selected Settings path conflicts with a Launcher root or the native Harness home
- **THEN** relocation fails before the active settings record changes
- **AND** the previous Settings location remains active

### Requirement: Native Harness home remains external and stable

The Harness home resolved by the selected child process from inherited `DSH_HOME`, or `~/.dsh` when it is not set, SHALL remain owned by DeepSeek Harness. The launcher SHALL NOT register that home, set or clear `DSH_HOME`, create a replacement `.dsh`, migrate it, clear it, copy it, or partition it by Git revision.

#### Scenario: User switches the selected revision

- **WHEN** the user activates a different exact Harness worktree
- **THEN** the launcher changes only the managed worktree and related Launcher generations
- **AND** the child retains normal resolution of the same inherited `DSH_HOME` or default `~/.dsh`

#### Scenario: Existing native state is incompatible

- **WHEN** preflight or the selected child reports that the existing native Harness state cannot be used safely
- **THEN** the launcher blocks readiness and presents the reported condition
- **AND** it does not select another revision, alter the home, or create an empty `.dsh`

### Requirement: Launcher owns downloaded plugin and preset sources

The Launcher SHALL keep downloaded plugin sources below `~/.dshlauncher/plugins` and downloaded Agent preset sources below `~/.dshlauncher/presets`. Its desktop selections and source records SHALL remain below Launcher Settings. The Launcher SHALL NOT write a DSH profile, plugin root, Agent preset root, or other native Harness state.

#### Scenario: Launcher records a downloaded extension source

- **WHEN** a user downloads a plugin or Agent preset repository through the Launcher
- **THEN** the Launcher stores that source below its matching `.dshlauncher` root
- **AND** it leaves all native DSH paths unchanged

### Requirement: Root selection proves containment and native-home separation

The launcher SHALL canonicalize every root before registration and use. A selected root SHALL be rejected when it is a filesystem root, a user home, a symbolic-link or junction escape, equal to or nested inside another Launcher root, contains another Launcher root, contains the resolved native Harness home, is contained by that home, or includes a `.dsh` path segment. All Launcher-created descendants SHALL derive from a registered root id and validated downward relative path.

#### Scenario: Candidate overlaps an existing or native location

- **WHEN** a selected root overlaps another registered root or the resolved native Harness home in either direction
- **THEN** registration fails before a registry record or child directory is created

#### Scenario: Root identity changes after registration

- **WHEN** a registered root is missing, unreadable, substituted, or resolves to a different canonical identity at operation time
- **THEN** the launcher blocks the operation or enters explicit recovery
- **AND** it does not infer a replacement path

### Requirement: Root contents remain role-specific

The Harness root SHALL contain Launcher-managed mirrors, exact worktrees, build artifacts, and operation records. The Plugins root SHALL contain downloaded plugin source repositories. The Presets root SHALL contain downloaded Agent preset source repositories. The Settings root SHALL contain Launcher registry, installation catalog, preferences, and diagnostic references. The native Harness home SHALL be outside all four roles.

#### Scenario: Launcher creates a workspace namespace

- **WHEN** a workspace is created from valid root registrations
- **THEN** the launcher creates one validated namespace beneath each role-specific root
- **AND** it does not write native Harness state into any of those namespaces

### Requirement: Main-process capabilities restrict external paths

The renderer SHALL never submit an arbitrary path for a managed operation. A path outside the four roots SHALL be available only through an opaque main-process capability created by explicit native selection or explicit executable registration, including an external working directory, read-only unmanaged-repository inspection, Git, Node.js, or pnpm.

#### Scenario: Renderer supplies an ungranted path

- **WHEN** a renderer request includes an arbitrary absolute path or a capability with the wrong purpose
- **THEN** Electron main rejects the request before filesystem or subprocess activity

### Requirement: Launcher-owned persistence fails closed

Launcher root, workspace, installation, tool, and preference records SHALL have explicit format versions and reject unknown fields, missing fields, malformed values, unsupported versions, and obsolete records that describe an unrecognized role or Launcher-managed `.dsh`. The launcher MAY migrate only Launcher-owned records after explicit user confirmation and SHALL never parse or migrate native Harness state.

#### Scenario: Registry record is unsupported

- **WHEN** the launcher reads a record with an unsupported version, unknown field, unrecognized role, or managed `.dsh` entry
- **THEN** it enters a blocking recovery state
- **AND** it leaves the native Harness home untouched
