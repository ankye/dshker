## Purpose

Defines a prototype-led desktop workflow for selecting a DSH version, changing only Launcher-owned advanced options, managing core and extension sources, supervising standard DSH Web processes, and opening the running Web surface without hidden state changes.

## ADDED Requirements

### Requirement: First-run uses defaults without a directory wizard

The launcher SHALL open its normal workspace and clone surface on first run. It SHALL create private defaults for Launcher-owned storage and explain that DSH owns the native profile, plugins, and Agent presets. Settings storage SHALL expose an explicit later change action rather than appearing in first-run setup.

#### Scenario: User starts the Launcher

- **WHEN** no Launcher state exists
- **THEN** the launcher creates validated defaults and enables workspace creation
- **AND** it states that `DSH_HOME` and `~/.dsh` are DSH-owned and are not moved or reset

#### Scenario: User selects an unsafe root

- **WHEN** a root conflicts with another root or the resolved native Harness home
- **THEN** the launcher identifies the rejected role and reason
- **AND** it leaves the previous registrations unchanged

### Requirement: Workspace onboarding supports explicit clone and revision choices

The launcher SHALL let the user select a managed workspace, Git remote, branch/tag/commit, Git executable, Node.js executable, and pnpm executable explicitly. It SHALL show progress, cancellation, observed remote/ref identity, exact resolved SHA, and blocking failures. It SHALL not silently choose a remote, ref, executable, or unmanaged checkout.

#### Scenario: User clones a selected remote

- **WHEN** all required selections validate and the user confirms clone
- **THEN** the launcher displays managed clone and exact-worktree progress
- **AND** it reports the resulting SHA and retained worktree identity

#### Scenario: Required onboarding choice is missing

- **WHEN** a remote, ref, working directory, tool, or root registration is unresolved
- **THEN** the launcher keeps the action blocked and identifies the missing choice
- **AND** it performs no partial clone or inferred selection

### Requirement: Sidebar follows the Launcher information hierarchy

The launcher SHALL use a narrow, collapsible persistent sidebar. It SHALL present the six primary entries in this exact order: Launch, Advanced options, Version management, Controller, Settings, and Run. The active entry SHALL have a visible selected state; collapsing the sidebar SHALL preserve the reachable name of every entry for assistive input.

#### Scenario: User changes the active page

- **WHEN** the user selects a sidebar entry
- **THEN** the matching page becomes active without moving or reconfiguring any DSH-owned path
- **AND** the sidebar makes the selected entry distinguishable

#### Scenario: User collapses the sidebar

- **WHEN** the user activates the sidebar collapse control
- **THEN** the sidebar reduces to its compact navigation rail
- **AND** each primary destination remains keyboard reachable with an accessible name

### Requirement: Launch page foregrounds only launch-critical state

The Launch page SHALL show the Launcher splash region, the selected launch revision, its exact DSH commit, current process state, and a direct start or stop action. It SHALL not make directory registration, plugin sources, or toolchain configuration compete with the launch action.

#### Scenario: No version is installed

- **WHEN** no managed DSH worktree exists
- **THEN** the Launch page states that no version can be started
- **AND** it directs the user to Version management without presenting a synthetic launch target

### Requirement: Launch page explains the selected product version and trusted source links

The Launch page SHALL identify the compiled Launcher version, explain that the selected DSH commit below is the launchable core identity, and state that native `~/.dsh` remains DSH-owned. It SHALL provide named actions for only the fixed DSH Launcher and DeepSeek Harness GitHub repositories. The Renderer SHALL NOT submit an arbitrary URL to Electron or open an unapproved destination.

#### Scenario: User opens a source repository

- **WHEN** the user chooses either source action on Launch
- **THEN** Electron main opens the matching fixed HTTPS GitHub URL in the operating-system browser
- **AND** the Renderer receives no general external-navigation capability

#### Scenario: Source action cannot open

- **WHEN** the operating system refuses the selected fixed source URL
- **THEN** the Launch page reports the failed action
- **AND** it does not substitute another URL or browser surface

### Requirement: Version management uses three distinct tabs

The Version management page SHALL provide three tabs in this order: Core, Extensions, and Install extension. Core SHALL contain the existing explicit DSH clone, seed import, revision-switch, and version-list controls. Extensions and Install extension SHALL identify their distinct Launcher source roots and show an explicit empty state when no authoritative extension records are available.

#### Scenario: User opens installed extensions

- **WHEN** the user selects the Extensions tab
- **THEN** the launcher identifies the registered extension-source directory
- **AND** it does not invent an installed extension list when no source record exists

#### Scenario: User opens extension installation

- **WHEN** the user selects the Install extension tab
- **THEN** the launcher identifies the registered preset or extension-catalog source directory
- **AND** an explicit user-triggered install is the only path that changes the profile

### Requirement: Plugin management goes through the standard DSH CLI forwarder

The Extensions view SHALL read the native `web` profile manifest read-only and distinguish in-box template bundles (`default`) from installed dependencies (`user-installed`). The Install extension view SHALL offer explicit install actions for curated GitHub sources. Install and uninstall SHALL be named typed operations that run the standard `dsh plugin --profile web add/remove` forwarder in the Launcher-owned Harness checkout; the Launcher SHALL NOT write the profile manifest, its node_modules, or the bundles list directly. Both actions SHALL be blocked while a Launcher-started DSH Web process is running.

#### Scenario: User installs a curated plugin

- **WHEN** the user triggers install for one curated GitHub source
- **THEN** the launcher runs `dsh plugin --profile web add <source>` in the Harness checkout
- **AND** the refreshed Extensions list reports the plugin as user-installed

#### Scenario: User uninstalls a plugin

- **WHEN** the user triggers uninstall for a user-installed plugin
- **THEN** the launcher runs `dsh plugin --profile web remove <name>` and reconciles the layer list only through that CLI
- **AND** in-box template bundles show no uninstall action

### Requirement: Core view exposes immutable revision state

The Harness view SHALL show the selected remote, observed branch/tag/commit, exact SHA, worktree verification, retained versions, active state, rewritten-ref observation, and explicit switch or rollback actions. It SHALL distinguish an observed ref update from activation of a new SHA.

#### Scenario: A branch advances after activation

- **WHEN** fetch observes the selected branch at a new SHA
- **THEN** the view keeps the active worktree identity visible
- **AND** it presents the new SHA as an explicit candidate rather than switching automatically

#### Scenario: Worktree is blocked

- **WHEN** verification detects a dirty, tampered, or active worktree condition
- **THEN** the view shows the condition and blocks unsafe actions
- **AND** it does not offer an automatic reset or cleanup action

### Requirement: Advanced options and Settings have distinct ownership views

The launcher SHALL place Launcher directory, workspace, and external-tool configuration under Advanced options. It SHALL place appearance, npm-acceleration, and interface-language controls under Settings. It SHALL present native Harness-home status as external read-only ownership and SHALL not provide Launcher controls to migrate, reset, clear, or recreate it.

#### Scenario: User opens advanced options

- **WHEN** the user needs to inspect Launcher-owned roots, workspaces, or toolchains
- **THEN** the launcher presents those controls under Advanced options
- **AND** it does not surface them as first-run launch choices

#### Scenario: User inspects native Harness-home status

- **WHEN** the launcher presents information about native Harness persistence
- **THEN** it states that the home is resolved by Harness and is outside Launcher management
- **AND** it presents no mutation action for that home

### Requirement: Controller and Run remain separate surfaces

The Controller view SHALL show the standard DSH Web start command, exact managed revision state, and valid start or stop controls. The Run view SHALL provide a tab strip that can add and switch independent local DSH Web pages. It SHALL not treat a browser tab as proof that the DSH child process is ready.

#### Scenario: User starts the controller process

- **WHEN** the user starts a managed DSH worktree from Controller
- **THEN** the view reflects only the child lifecycle state confirmed by Electron main
- **AND** it exposes the exact managed revision that owns the process

#### Scenario: User opens a Run page

- **WHEN** the user adds a Run tab
- **THEN** the launcher opens the declared loopback DSH Web address in that tab
- **AND** a failed page load does not alter controller lifecycle state or substitute another version

### Requirement: Asynchronous product states remain accessible

All Launcher surfaces SHALL provide distinguishable loading, empty, progress, success, cancellation, blocked, error, and stale-generation states. User-visible copy SHALL be locale-owned, keyboard navigation and focus SHALL remain usable, and long paths, refs, and SHA values SHALL not obscure the associated action or state.

#### Scenario: Earlier operation completes after selection changes

- **WHEN** an older clone, validation, or lifecycle operation completes after the user selected another workspace or generation
- **THEN** the launcher ignores or labels the stale result
- **AND** it does not overwrite the newer selection state
