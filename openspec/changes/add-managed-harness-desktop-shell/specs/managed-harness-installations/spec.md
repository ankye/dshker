## Purpose

Defines how the Launcher clones DeepSeek Harness, resolves user-selected revisions, and prepares isolated revision-bound plugin and configuration artifacts without mutating unmanaged source.

## ADDED Requirements

### Requirement: Packaged first launch initializes the default Harness directory in background

When `~/.dshlauncher/harness` is an empty direct directory, a packaged Launcher SHALL immediately render its main window and initialize that directory in the background from the bundled DeepSeek Harness Git bundle. Initialization SHALL clone the bundled `master` history, set the origin to the public HTTPS remote, run the declared dependency installation, build the DSH CLI, and atomically place the completed checkout in the Harness directory. It SHALL not read, write, migrate, or recreate `~/.dsh`.

#### Scenario: Empty default Harness directory

- **WHEN** the packaged Launcher starts with an empty direct `~/.dshlauncher/harness` directory
- **THEN** the main window is available while initialization runs
- **AND** the one-click launch control remains disabled until the built checkout is ready
- **AND** the completed checkout reports its Git commit history as available core versions

#### Scenario: Existing default Harness directory

- **WHEN** `~/.dshlauncher/harness` is not empty
- **THEN** the Launcher leaves it unchanged
- **AND** it reports an invalid or unavailable checkout explicitly when required DSH files are absent

### Requirement: User-selected remote creates a managed installation

The launcher SHALL accept only an explicit supported DeepSeek Harness Git remote identity and user-selected branch, tag, or commit. It SHALL create the managed mirror and worktrees only under the registered Harness root, record the remote identity, and bind the result to the selected workspace. It SHALL NOT use an unmanaged checkout as mirror storage or alter it through managed Git workflows.

#### Scenario: User clones a Harness remote

- **WHEN** the user supplies a valid remote and ref with valid Harness-root registration
- **THEN** the launcher creates a managed mirror under a validated Harness-root namespace
- **AND** it records the selected remote and ref observation before exposing a runnable installation

#### Scenario: Remote identity is invalid

- **WHEN** the remote is absent, malformed, unsupported, credential-bearing, or differs from the confirmed identity
- **THEN** the launcher blocks clone or fetch before creating a worktree
- **AND** it does not choose another remote

### Requirement: Selected refs resolve to immutable worktrees

The launcher SHALL resolve every requested branch, tag, or commit from its managed mirror to one exact commit SHA before activation. A runnable revision SHALL use a detached managed worktree keyed by that SHA. The active record SHALL name the exact SHA and worktree; branch and tag names remain observed metadata and SHALL NOT be runtime identity.

#### Scenario: User selects a branch revision

- **WHEN** a managed mirror resolves the selected branch to a commit SHA
- **THEN** the launcher materializes and verifies a detached worktree for that SHA
- **AND** it records that SHA as the candidate runtime identity

#### Scenario: Observed ref changes target

- **WHEN** a subsequent fetch observes a branch or tag at a different commit
- **THEN** the launcher retains the previously selected worktree
- **AND** it requires an explicit user action before activating the newly observed SHA

### Requirement: Version management separates remote refresh from activation

The Core version view SHALL show the HTTPS origin, current branch, current complete commit SHA, stable release tags, and development commits from the fetched origin branch. Its Refresh action SHALL run `git fetch --prune --tags origin` and rebuild those lists without checking out, installing, building, or restarting DSH. Its update, branch-switch, and row-switch actions SHALL require an explicit user activation and SHALL refuse while the Launcher-started DSH Web process is running.

#### Scenario: User refreshes the version list

- **WHEN** the user invokes Refresh list
- **THEN** the Launcher fetches origin branches and tags over the configured HTTPS remote
- **AND** the current checkout, native `.dsh`, and running DSH Web process remain unchanged

#### Scenario: User activates a listed version

- **WHEN** the user selects Update, a branch, or a version row while DSH Web is stopped
- **THEN** the Launcher runs `git clean -xdf` in the verified Launcher-owned Harness checkout, checks out the selected fetched commit, installs its locked dependencies, and builds its DSH CLI before marking it launchable
- **AND** the selected row becomes the current version only after those operations complete

### Requirement: Curated plugin catalog is a parsed Launcher-owned source checkout

The Install extension view SHALL use `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git` as its sole curated catalog source. A user-triggered refresh SHALL clone or update that source below `~/.dshlauncher/plugins/awesome-dsh-plugin`, parse `data/plugins/*.yml`, and display each entry's name, GitHub URL, category, and localized description. Reading or refreshing this catalog SHALL not install a plugin or modify native `.dsh` state.

#### Scenario: User refreshes the curated plugin catalog

- **WHEN** the user invokes Refresh list in Install extension
- **THEN** the Launcher updates only its `awesome-dsh-plugin` source checkout and parses its YAML records
- **AND** it displays the resulting curated entries without running `dsh plugin add`

### Requirement: Managed worktrees are retained and mutation-protected

The launcher SHALL block switching, updating, deleting, or retargeting a worktree that is active, starting, stopping, unresolved after a crash, tampered with, or still referenced by a retained rollback record. Before an explicit switch or update rebuilds a verified Launcher-owned Harness checkout, it SHALL run `git clean -xdf` in that checkout to remove untracked and ignored dependency and build residue. It SHALL NOT reset tracked files or run cleanup in an unmanaged repository, native DSH home, plugin directory, preset directory, or settings directory. Explicit deletion of an inactive worktree SHALL require proof of exact target containment and absence of all active references.

#### Scenario: User attempts to switch while a runtime is active

- **WHEN** the selected installation has an active or unresolved child runtime
- **THEN** the launcher blocks the worktree mutation
- **AND** it identifies the runtime condition rather than force-stopping it

#### Scenario: Worktree has unexpected changes

- **WHEN** a user activates a listed version in a verified Launcher-owned checkout with untracked or ignored build residue
- **THEN** the launcher runs `git clean -xdf` before checkout and dependency installation
- **AND** tracked files remain untouched and no cleanup occurs outside that checkout

### Requirement: Git, Node.js, and pnpm are explicit registered executables

Every Git, Node.js, and pnpm invocation SHALL execute the exact user-selected and revalidated binary directly, without a shell, `PATH` lookup, global substitution, or a fallback package manager. Node.js SHALL satisfy the selected worktree's declared `engines.node`; pnpm SHALL match its declared `packageManager` and declared lockfile. The launcher SHALL use an explicit working directory and controlled environment for each invocation.

#### Scenario: Tool preflight succeeds

- **WHEN** the selected executable identities and declared versions are valid for the selected worktree
- **THEN** the launcher permits the corresponding managed operation
- **AND** it records the verified executable identity with the installation

#### Scenario: Tool preflight fails

- **WHEN** an executable is missing, changed, unreadable, timed out, or fails its version constraint
- **THEN** the launcher blocks the operation before clone, build, install, or launch
- **AND** it does not try another executable, Electron's Node runtime, npm, Corepack, or a global `dsh`

### Requirement: Plugin and configuration generations remain separate

The launcher SHALL create plugin artifacts only beneath the Plugins root and configuration artifacts only beneath the Configuration root. Each generation SHALL record the exact Harness SHA it was prepared for and SHALL be verified before it can be selected for launch. Configuration and plugin generations SHALL never share a writable namespace across distinct selected revisions.

#### Scenario: Revision preparation succeeds

- **WHEN** the selected worktree, explicit Node.js/pnpm tools, declared manifest, and lockfile pass preflight
- **THEN** the launcher creates separate revision-bound plugin and configuration generations
- **AND** it records their identities for launch preflight

#### Scenario: Revision preparation fails

- **WHEN** dependency installation, lockfile validation, plugin verification, or configuration validation fails
- **THEN** the launcher leaves the current active generations unchanged
- **AND** it does not launch with a partial or inferred generation

### Requirement: Unmanaged repositories remain read-only

An existing repository can be inspected only after explicit user selection through a read-only capability. The launcher SHALL NOT check out, switch, pull, reset, clean, stash, rebase, alter remotes, or write source files in that repository. Registering a source from such inspection SHALL still clone into the Launcher-managed Harness root before it is runnable.

#### Scenario: User inspects a local repository

- **WHEN** the user grants a read-only repository inspection capability
- **THEN** the launcher reports its observed identity and available explicit choices
- **AND** it performs no Git or source mutation in that repository
