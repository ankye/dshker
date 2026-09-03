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

The launcher SHALL use a narrow persistent sidebar with three presentation states: expanded cards, a collapsed icon rail, and hidden. It SHALL present the six primary entries in this exact order: Launch, Controller, Version management, Token usage, Settings, and Run. Controller SHALL follow Launch directly because launch output is its immediate next context. Run SHALL use a browser-window icon. The active entry SHALL have a visible selected state; collapsing the sidebar SHALL preserve the reachable name of every entry for assistive input. A large, floating lower-left chevron control SHALL cycle expanded to collapsed to hidden and then back to expanded; it SHALL remain reachable when the sidebar is hidden.

#### Scenario: User changes the active page

- **WHEN** the user selects a sidebar entry
- **THEN** the matching page becomes active without moving or reconfiguring any DSH-owned path

### Requirement: Token usage supports range-scoped daily model analysis

The Token usage page SHALL provide Overview and Statistics tabs. Statistics SHALL list the exact DSH-recorded token totals grouped by local calendar day and recorded model, with visible start and end date controls plus recent-range presets. It SHALL provide switchable column charts for daily total usage and daily per-model comparison using the same selected range; the exact totals table remains available as the readable comparison view. The range filter SHALL operate on Launcher-cached aggregates without rereading unchanged DSH session logs. A Refresh control SHALL have the same icon-and-label affordance as the version-management refresh controls and show an honest pending state while the authoritative log read is in progress. The Launcher SHALL use an event's recorded timestamp and active model header for daily attribution; usage records without a timestamp SHALL remain in session totals but SHALL NOT be assigned to an invented day.

#### Scenario: User narrows token statistics to a time range

- **WHEN** the user sets a start date, end date, or a recent-range preset
- **THEN** the daily model table immediately shows only records within that inclusive range
- **AND** the underlying DSH session logs are not reread solely because the range changed
- **AND** the sidebar makes the selected entry distinguishable

#### Scenario: User cycles sidebar presentation

- **WHEN** the user activates the floating sidebar control while expanded
- **THEN** the sidebar reduces to its compact navigation rail
- **AND** each primary destination remains keyboard reachable with an accessible name
- **WHEN** the user activates the control again
- **THEN** the sidebar hides while the control remains available at the lower-left edge
- **WHEN** the user activates the control while hidden
- **THEN** the expanded card sidebar returns

### Requirement: Launch page foregrounds only launch-critical state

The Launch page SHALL show the Launcher splash region, the selected launch revision, its exact DSH commit, current process state, and a direct start or stop action. It SHALL not make directory registration, plugin sources, or toolchain configuration compete with the launch action.

When a launchable revision is selected, the launch action SHALL be the page's only primary button and occupy the bottom-right of a persistent Launch action bar outside the scrollable page content. The selected-core card SHALL identify the current branch and exact DSH commit, and offer a secondary route to Version management. A core-update notice SHALL appear only when the Launcher has an authoritative update observation; it SHALL not reserve a card or claim that an update exists when no such observation is available. The action bar SHALL remain visible while the Launch content scrolls, without overlaying the content or adding spacer content to the scroll plane.

#### Scenario: No version is installed

- **WHEN** no managed DSH worktree exists
- **THEN** the Launch page states that no version can be started
- **AND** it directs the user to Version management without presenting a synthetic launch target

#### Scenario: User views a launchable revision

- **WHEN** the Launcher has a ready selected revision
- **THEN** the selected revision begins at the top-left and its start action sits in the bottom-right of the persistent Launch action bar
- **AND** the content can scroll independently without moving, overlapping, or creating a spacer region for that action
- **AND** the selected-core card shows current branch and exact commit with a route to explicit version management, without asserting an unobserved update

### Requirement: Launch page explains the selected product version and trusted source links

The Launch page SHALL identify the compiled Launcher version, explain that the selected DSH commit below is the launchable core identity, and state that native `~/.dsh` remains DSH-owned. It SHALL provide named actions for only the fixed DSHKer Launcher and DeepSeek Harness GitHub repositories. The Renderer SHALL NOT submit an arbitrary URL to Electron or open an unapproved destination.

#### Scenario: User opens a source repository

- **WHEN** the user chooses either source action on Launch
- **THEN** Electron main opens the matching fixed HTTPS GitHub URL in the operating-system browser
- **AND** the Renderer receives no general external-navigation capability

#### Scenario: Source action cannot open

- **WHEN** the operating system refuses the selected fixed source URL
- **THEN** the Launch page reports the failed action
- **AND** it does not substitute another URL or browser surface

### Requirement: Product display name preserves persistent Launcher identities

The desktop window, packaged application, release artifact names, product documentation, and fixed source action SHALL identify the product as DSHKer Launcher and use the `ankye/dshker` repository. The existing `dsh-launcher` application id, bundle id, IPC namespace, preference keys, resource names, and `~/.dshlauncher` directory SHALL remain unchanged.

#### Scenario: Existing Launcher user installs the renamed application

- **WHEN** an existing user starts DSHKer Launcher
- **THEN** the window and product pages show DSHKer Launcher
- **AND** the application continues to use the existing Launcher-owned state and native DSH ownership boundary

### Requirement: Version management uses three distinct tabs

The Version management page SHALL provide three tabs in this order: Core, Extensions, and Install extension. Core SHALL contain the existing explicit DSH clone, seed import, revision-switch, and version-list controls. Extensions SHALL show the actual native DSH profile installation result rather than treating Launcher-downloaded sources as a second installation list. Install extension SHALL identify the catalog source and show an explicit empty state when no authoritative catalog records are available.

#### Scenario: User opens installed extensions

- **WHEN** the user selects the Extensions tab
- **THEN** the launcher reads the native `web` profile and offers a refresh action for that result
- **AND** it does not display cached Launcher source directories as installed extensions

#### Scenario: User opens extension installation

- **WHEN** the user selects the Install extension tab
- **THEN** the launcher identifies the registered preset or extension-catalog source directory
- **AND** an explicit user-triggered install is the only path that changes the profile

### Requirement: Version-list refresh feedback is shared and visible

Each user-triggered Refresh control in Core, Extensions, and Install extension SHALL show one shared indeterminate status track while its corresponding authoritative refresh is pending. The track SHALL use the full available status-bar width without claiming a measured completion percentage. On completion or error, it SHALL return to the ordinary status information.

The three tabs SHALL use one consistent version-management workspace: a compact tab-specific scope line above the content and one shared tab-strip action area for list refresh. Core branch selection SHALL remain with the displayed Core scope. Batch install and uninstall actions SHALL remain with their respective tables. Install extension SHALL expose Git and ZIP-source install commands beside Refresh rather than as persistent controls above the list; a selected ZIP SHALL be extracted below the Launcher-managed plugins root before DSH installs it. Catalog descriptions SHALL remain fully readable in the list. List-shaped information SHALL remain in the common bordered table plane; each tab MAY add task-specific controls without moving Refresh into that content plane.

The Install extension catalog SHALL place its complete category filter list in a persistent vertical sidebar beside the results table. The category list MAY scroll vertically when needed, but SHALL NOT require horizontal tag-strip scrolling. The category rail SHALL share the dark workspace canvas with the result table and use a quiet divider plus selected-state indicator instead of a separately filled card. Search remains above the category-and-results workspace; catalog provenance is supporting text beneath that search rather than a competing line below the tab strip; selecting a category preserves the current search text and filters the result table.

#### Scenario: User refreshes any version-management list

- **WHEN** the user invokes the Core, Extensions, or Install extension refresh control
- **THEN** the status bar identifies the pending list and shows the shared indeterminate track for that operation
- **AND** it returns to ordinary status only after the corresponding refresh settles

### Requirement: Plugin management materializes controlled sources through the standard DSH CLI forwarder

The Extensions view SHALL read the native `web` profile manifest read-only and distinguish in-box template bundles (`default`) from installed dependencies (`user-installed`). It SHALL group companion runtime and settings packages from one source into one extension row, while showing the required DSH base and Web app bundles separately with no uninstall control. Its action group SHALL be its second table column. The Install extension view SHALL offer explicit Git HTTPS and native-selected ZIP-package sources. Install and uninstall SHALL be named typed operations that materialize each source under the Launcher-controlled plugins directory, then run the standard `dsh plugin --profile web add/remove` forwarder in the Launcher-owned Harness checkout. For each Git-managed plugin, the Extensions view SHALL show its persisted current commit and expose an update action. An explicit Refresh SHALL fetch each managed source branch and disable Update when no newer commit exists. An unrecorded local GitHub plugin SHALL show a separate Manage action and no Update action; Manage SHALL first derive the checkout's selected branch and package-relative path, clone that exact package source to the Launcher root, then forward the normal DSH add command before it records the source. The Manage action SHALL disappear after management succeeds. Update SHALL fetch and select the declared source branch, persist its exact resulting commit, then run `dsh plugin --profile web update <package>` for that package. If the Git remote cannot be resolved, the source column SHALL show `local`. The Launcher SHALL NOT write the profile manifest, its node_modules, or the bundles list directly. All three actions SHALL be blocked while a Launcher-started DSH Web process is running.

#### Scenario: User installs a curated plugin

- **WHEN** the user triggers install for one Git or ZIP-package source
- **THEN** the launcher materializes a source below `~/.dshlauncher/plugins` and runs `dsh plugin --profile web add file:<managed-source>` in the Harness checkout
- **AND** the refreshed Extensions list reports the plugin as user-installed

#### Scenario: User uninstalls a plugin

- **WHEN** the user triggers uninstall for a user-installed plugin with a Launcher source record
- **THEN** the launcher runs `dsh plugin --profile web remove <name> --config.offline=true` and reconciles the layer list only through that CLI
- **AND** it removes only the mapped Launcher source after DSH succeeds, while in-box template bundles show no uninstall action
- **AND** a non-exiting DSH command is terminated as one bounded process tree and reported as a failed operation rather than leaving the view pending indefinitely

#### Scenario: User updates a Git-managed plugin

- **WHEN** the user selects update for a user-installed plugin with a managed Git source record
- **THEN** the Extensions view retains that source's current commit and shows the updated exact commit after the fetch
- **AND** the Launcher reconciles only that package through the DSH plugin forwarder
- **AND** a local-copy plugin, a non-GitHub source, and an unrecorded native plugin do not show an update action

#### Scenario: User moves an existing local GitHub extension under management

- **WHEN** the user chooses manage and update for an installed extension whose every package resolves to a local GitHub checkout
- **THEN** the Launcher clones each exact current branch and package child into `~/.dshlauncher/plugins` and forwards DSH's add command for each package
- **AND** the refreshed Extensions list still has one row from the native profile, now with the persisted managed Git revision

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

### Requirement: Settings separates DSH and Launcher ownership views

The launcher SHALL not expose an Advanced options route. Settings SHALL provide DSH settings and Launcher settings tabs. DSH settings SHALL expose only Launcher-forwarded DSH Web runtime options, including the requested launch port, and SHALL state that native `~/.dsh` remains DSH-owned. Launcher settings SHALL contain appearance, interface-language, and Launcher-managed directory and workspace controls. The launcher SHALL present native Harness-home status as external read-only ownership and SHALL not provide Launcher controls to migrate, reset, clear, or recreate it.

#### Scenario: User opens Launcher settings

- **WHEN** the user needs to inspect Launcher-owned roots, workspaces, or toolchains
- **THEN** the launcher presents the applicable directory and workspace controls under the Launcher settings tab
- **AND** it does not surface them as first-run launch choices

#### Scenario: User opens DSH settings

- **WHEN** the user needs to choose the DSH Web port requested at launch
- **THEN** the launcher presents the port control under the DSH settings tab
- **AND** it states that the setting is forwarded at launch and does not mutate native `~/.dsh`

#### Scenario: User inspects native Harness-home status

- **WHEN** the launcher presents information about native Harness persistence
- **THEN** it states that the home is resolved by Harness and is outside Launcher management
- **AND** it presents no mutation action for that home

### Requirement: Controller and Run remain separate surfaces

The Launch and Controller footers SHALL show valid start or stop controls for the Launcher-created DSH Web child. A running child SHALL leave both controls enabled and change the action to stop. The Controller view SHALL show live DSH Web output and durable log-file controls. It SHALL provide a log-only contextual copy action that copies a selected excerpt or the invoked log row. It SHALL not expose Launcher-internal command-line arguments as a separate summary card. Its action SHALL use the same persistent footer treatment as the Launch action. Runtime observation refreshes SHALL not assert the user-action busy state or animate the active route. The Run view SHALL provide a tab strip that can add and switch independent local DSH Web pages. Its loopback Web guests SHALL offer a native contextual menu limited to back, forward, reload, cut, copy, paste, and select-all; it SHALL not offer developer tools, external navigation, or unrestricted guest capabilities. It SHALL not treat a browser tab as proof that the DSH child process is ready.

#### Scenario: User starts the controller process

- **WHEN** the user starts a managed DSH worktree from Controller
- **THEN** the view reflects only the child lifecycle state confirmed by Electron main
- **AND** it exposes the exact managed revision that owns the process

#### Scenario: User opens a Run page

- **WHEN** the user adds a Run tab
- **THEN** the launcher opens the declared loopback DSH Web address in that tab
- **AND** a failed page load does not alter controller lifecycle state or substitute another version

#### Scenario: User opens a Run-page context menu

- **WHEN** the user right-clicks inside an attached loopback DSH Web guest
- **THEN** the launcher shows only the native navigation and editing actions for that guest
- **AND** it does not expose developer tools, arbitrary external navigation, or a separate Electron guest capability

### Requirement: Asynchronous product states remain accessible

All Launcher surfaces SHALL provide distinguishable loading, empty, progress, success, cancellation, blocked, error, and stale-generation states. User-visible copy SHALL be locale-owned, keyboard navigation and focus SHALL remain usable, and long paths, refs, and SHA values SHALL not obscure the associated action or state.

#### Scenario: Earlier operation completes after selection changes

- **WHEN** an older clone, validation, or lifecycle operation completes after the user selected another workspace or generation
- **THEN** the launcher ignores or labels the stale result
- **AND** it does not overwrite the newer selection state
