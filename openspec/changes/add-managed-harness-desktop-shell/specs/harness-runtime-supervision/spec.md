## Purpose

Defines exact-worktree preflight and Node child lifecycle rules so a desktop launch starts the selected standard DSH Web application without modifying native Harness behavior.

## ADDED Requirements

### Requirement: Preflight proves the selected runtime inputs

Before building or launching a revision, the launcher SHALL prove the registered Git, Node.js, and pnpm identities, selected exact worktree SHA, and required built CLI artifact. Missing or mismatched inputs SHALL block launch.

#### Scenario: Preflight accepts an exact revision

- **WHEN** all required registered inputs match the selected candidate
- **THEN** the launcher marks that candidate ready to spawn
- **AND** its diagnostic snapshot identifies the exact SHA and registered executable identities

#### Scenario: Preflight input is unresolved

- **WHEN** any selected tool, worktree, generation, or external working directory cannot be proven
- **THEN** the launcher blocks launch with an actionable failure
- **AND** it does not infer another input

### Requirement: Child preserves normal Harness-home resolution

The launcher SHALL start the child without setting, clearing, translating, or otherwise modifying `DSH_HOME`. The selected Harness child SHALL resolve its home from its inherited environment or default `~/.dsh` according to normal Harness behavior. The launcher SHALL not read, write, compare, migrate, reset, or create that home while changing revisions.

#### Scenario: Child starts after a branch switch

- **WHEN** the launcher starts a newly selected managed worktree
- **THEN** the child retains the inherited `DSH_HOME` or default `~/.dsh`
- **AND** only the managed worktree and Launcher generations differ from the previous launch

### Requirement: Runtime starts through the selected named profile

The launcher SHALL spawn only the registered Node executable and the selected worktree's built `apps/cli/lib/bin.js` as `dsh web --no-open`, with the selected worktree as cwd. The spawn SHALL not set, clear, or alter `DSH_HOME`, use a shell, a global `dsh`, a package bin, another worktree, or an Electron process as a substitute.

#### Scenario: Exact child command is constructed

- **WHEN** a candidate passes preflight
- **THEN** the launch request contains the verified Node path, selected CLI path, `web --no-open`, and selected worktree cwd
- **AND** it contains no fallback executable or inferred argument

#### Scenario: Expected CLI artifact is absent

- **WHEN** the selected worktree lacks the required built CLI artifact
- **THEN** the launcher blocks launch before child creation
- **AND** it does not use source mode, a global binary, or another revision

### Requirement: Lifecycle state and diagnostics are explicit

The launcher SHALL record bounded child standard output, standard error, exit, and stop evidence for each runtime generation. Its Console SHALL also show Launcher-owned lifecycle events for preflight, child creation, readiness, stopping, and exit, distinctly from child output. A pnpm one-line script echo SHALL be labeled as a launch command even when pnpm writes it through standard error. The child SHALL receive a Launcher-owned DSH `--patch` overlay that enables the Cordis console exporter at debug level without writing to the native DSH home or changing the selected Harness checkout. It SHALL expose distinct preflighting, starting, ready, stopping, stopped, crashed, and blocked states. It SHALL NOT parse native Harness persistence files for diagnostics.

The packaged application SHALL resolve pnpm for its current platform and supply the resulting command search path to every Launcher-owned pnpm operation. It SHALL not assume an interactive terminal PATH: macOS/Linux pnpm shebangs that use `env node` and Windows pnpm command shims must receive the platform-resolved command environment. Its `--patch` flags belong to the DSH `web` command (`pnpm dsh web --patch …`), not after pnpm's argument separator where DSH Web would receive them as unknown application options.

On POSIX, the Launcher SHALL spawn the pnpm child as a dedicated process group and terminate that group rather than only the pnpm wrapper. It SHALL wait for the root child to exit before reporting the runtime stopped or permitting a version mutation. Electron application quit and `SIGINT`/`SIGTERM` shutdown SHALL use the same termination path.

Readiness SHALL come from exactly one signal: the child's own startup URL announcement. Because this change ships no private child IPC handshake, an arbitrary log line, a successful spawn, or elapsed time SHALL NOT be treated as readiness. The launcher SHALL accept only a loopback http(s) announcement and SHALL preserve its URL unmodified, including any session credential.

#### Scenario: Child announces readiness

- **WHEN** the child prints its own startup URL line with a loopback http(s) address
- **THEN** the launcher transitions that generation from starting to ready and records the exact announced URL
- **AND** no other output text advances the state

#### Scenario: User controls the process from Console

- **WHEN** the Console displays a ready managed Harness checkout
- **THEN** its fixed bottom action shows the exact stopped, starting, running, or failed state
- **AND** the action starts the selected version when stopped or failed, disables while starting, and stops only the running managed child

#### Scenario: Packaged application starts without an interactive shell

- **WHEN** Finder, Explorer, or another desktop entry starts the packaged application with a reduced PATH
- **THEN** each Launcher-owned pnpm operation receives the dynamically resolved platform command path
- **AND** pnpm can resolve its matching Node executable without relying on the user's shell initialization files

#### Scenario: Child produces output without announcing a URL

- **WHEN** the child emits build or progress output only
- **THEN** the generation remains starting and exposes no runtime address
- **AND** the launcher does not infer a default port

#### Scenario: Child crashes during operation

- **WHEN** the child exits unexpectedly before or after readiness
- **THEN** the launcher withdraws its generation, preserves bounded diagnostic references, and reports that process-local work may be lost
- **AND** it requires explicit user action and complete preflight before another launch

#### Scenario: Launcher exits while DSH Web runs

- **WHEN** the Electron main process receives a normal quit request, `SIGINT`, or `SIGTERM` while its DSH child is running or starting
- **THEN** the Launcher signals the complete managed process tree and waits for the pnpm root child to exit
- **AND** it does not relinquish main-process ownership while that termination is unresolved

#### Scenario: User stops DSH before changing versions

- **WHEN** the user stops a managed DSH Web process and then requests a version mutation
- **THEN** the Launcher waits until the managed process tree has exited before reporting it stopped
- **AND** the mutation cannot overlap a listener from the previous revision

### Requirement: A run page loads only the URL the started process announced

The launcher SHALL treat the `dsh web` startup announcement as the only source of the runtime address. It SHALL parse that exact URL from the child's own output and SHALL NOT predict, default, or reconstruct a port or host. The announced URL may carry a session credential, so the launcher SHALL preserve it unmodified and SHALL NOT display or load a rebuilt address.

#### Scenario: The child announces its URL

- **WHEN** the started `dsh web` process prints its startup URL line
- **THEN** the launcher records that exact URL, including any credential it carries
- **AND** the runtime becomes reportable as running only at that point

#### Scenario: Output names a non-loopback address

- **WHEN** child output contains a URL whose host is not loopback or whose scheme is not http(s)
- **THEN** the launcher rejects that address
- **AND** the recorded runtime address remains unchanged

### Requirement: A run page exists only while its runtime runs

The launcher SHALL bind every run page to the current running process. When that process stops, fails, or is replaced, the launcher SHALL withdraw its pages rather than leaving a frame pointing at a dead or reused address.

#### Scenario: The runtime stops while a page is open

- **WHEN** the started process exits, crashes, or is stopped
- **THEN** the launcher withdraws the open run pages
- **AND** it does not retain the previous address for reuse

### Requirement: Runtime outcomes remain distinguishable

The launcher SHALL present spawn, readiness, lifecycle, and Harness business failures as distinct outcomes. A failed start, an unannounced URL, an unexpected exit, or a refused stop SHALL NOT be converted into a ready runtime or empty successful content.

#### Scenario: A start attempt fails

- **WHEN** the process cannot be created or exits before announcing its URL
- **THEN** the launcher reports the failure category and retains its diagnostics
- **AND** it does not report the runtime as running

### Requirement: One-click launch streams into the Launcher console

The Launcher SHALL retain a bounded, ordered stdout and stderr stream from the exact DSH Web child created by its one-click launch action. The Console view SHALL display that stream while the child is running and SHALL not create a second child merely to obtain output. It SHALL distinguish stdout from stderr and stop only the process it started.

#### Scenario: User opens Console after one-click launch

- **WHEN** the one-click launch child emits stdout or stderr
- **THEN** the Console view displays the emitted fragments in order with their stream identity
- **AND** stopping from Console terminates that same child process

### Requirement: macOS and Windows preserve the same refusal rules

Packaged macOS and Windows applications SHALL apply the same root-containment, exact-tool, exact-worktree, native-home noninterference, readiness, stop, and no-substitution requirements. A platform inability to prove a required condition SHALL block the affected operation.

#### Scenario: Platform-specific proof is unavailable

- **WHEN** a platform cannot validate the selected path, executable, process ownership, or announced readiness
- **THEN** the launcher reports a blocking platform-specific error
- **AND** it does not weaken the shared lifecycle rules
