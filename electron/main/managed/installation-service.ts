import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import type {
  CloneManagedHarnessRequest,
  InstallBundledHarnessSeedRequest,
  ManagedExecutableKind,
  ManagedExecutableSelection,
  ManagedHarnessInstallationView,
  ManagedHarnessLaunchView as RendererManagedHarnessLaunchView,
  ManagedInstallationsState,
  ManagedRevisionRequest,
  ManagedToolchainView,
  RegisterManagedToolchainRequest,
  RegisterManagedToolchainResult,
  StartManagedHarnessRequest,
  StopManagedHarnessRequest,
  SwitchManagedHarnessRevisionRequest
} from '../../../src/shared/contracts'
import { ManagedRootError } from './errors'
import {
  canonicalizeSelectedExecutable,
  type ExecutablePicker,
  type ExecutableSelectionCapabilities,
  type ExecutableSelectionCapability,
  type ExecutableSelectionPurpose
} from './executable-capabilities'
import {
  assertGitReferenceNotRewritten,
  createGitNamedRemote,
  createGitReferenceObservation,
  createManagedGitInstallationPaths,
  createManagedGitMirror,
  createManagedGitMirrorFromBundle,
  createGitExecutionEnvironment,
  fetchManagedGitMirror,
  GitCommandRunner,
  GitRuntimeError,
  materializeManagedGitWorktree,
  managedWorktreePath,
  parseGitCommitSha,
  registerGitExecutable,
  resolveGitRevision,
  selectGitBranch,
  selectGitCommit,
  selectGitTag,
  type GitExecutionContext,
  type GitRevisionSelection,
  type GitToolPolicy,
  verifyManagedGitWorktree
} from './git'
import { loadVerifiedBundledSeed, type VerifiedBundledSeed } from './bundled-seed'
import type {
  ManagedHarnessInstallationRecord,
  ManagedInstallationCatalog,
  ManagedToolchainRecord
} from './installation-catalog'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import {
  ManagedHarnessWebRuntimeSupervisor,
  type ManagedHarnessLaunchView as RuntimeManagedHarnessLaunchView
} from './harness-web-runtime'
import { ManagedWorkspaceService, type ResolvedManagedWorkspace } from './service'
import {
  createToolchainExecutionEnvironment,
  registerNodeExecutable,
  registerPnpmExecutable,
  type NodeExecutableRegistration,
  type PnpmExecutableLauncher,
  type ToolchainProcessContext
} from './toolchain'
import { ManagedHarnessWorktreePreparer } from './worktree-preparer'

const GIT_TOOL_POLICY: GitToolPolicy = {
  minimumVersion: { major: 2, minor: 30, patch: 0, text: '2.30.0' },
  maximumExclusiveVersion: { major: 3, minor: 0, patch: 0, text: '3.0.0' }
}

const TOOL_PROBE_CONFIGURATION_FILE = 'pnpm-probe.npmrc'

/** Constructor dependencies explicitly supplied by Electron main. */
export interface ManagedInstallationServiceOptions {
  readonly workspaceService: ManagedWorkspaceService
  readonly executableCapabilities: ExecutableSelectionCapabilities
  readonly executablePicker: ExecutablePicker
  readonly temporaryDirectory: string
  /** One launcher-lifetime supervisor; it owns only transient child state. */
  readonly runtimeSupervisor: ManagedHarnessWebRuntimeSupervisor
  /** Package-only seed reader; production never probes a source or development directory. */
  readonly bundledSeedLoader?: () => Promise<VerifiedBundledSeed>
  readonly gitRunner?: GitCommandRunner
  readonly worktreePreparer?: ManagedHarnessWorktreePreparer
}

/** Owns explicit executable registration, managed Git clone, and exact version switching. */
export class ManagedInstallationService {
  readonly #workspaceService: ManagedWorkspaceService
  readonly #executableCapabilities: ExecutableSelectionCapabilities
  readonly #executablePicker: ExecutablePicker
  readonly #temporaryDirectory: string
  readonly #runtimeSupervisor: ManagedHarnessWebRuntimeSupervisor
  readonly #bundledSeedLoader: () => Promise<VerifiedBundledSeed>
  readonly #gitRunner: GitCommandRunner
  readonly #worktreePreparer: ManagedHarnessWorktreePreparer
  #mutationActive = false

  constructor(options: ManagedInstallationServiceOptions) {
    this.#workspaceService = options.workspaceService
    this.#executableCapabilities = options.executableCapabilities
    this.#executablePicker = options.executablePicker
    this.#temporaryDirectory = options.temporaryDirectory
    this.#runtimeSupervisor = options.runtimeSupervisor
    this.#bundledSeedLoader = options.bundledSeedLoader ?? loadVerifiedBundledSeed
    this.#gitRunner = options.gitRunner ?? new GitCommandRunner()
    this.#worktreePreparer = options.worktreePreparer ?? new ManagedHarnessWorktreePreparer()
  }

  /** Projects only persisted installation facts and the supervisor's current non-persistent launch state. */
  async getState(): Promise<ManagedInstallationsState> {
    const catalog = await this.#workspaceService.getInstallationCatalog()
    return projectInstallationsState(catalog, this.#runtimeSupervisor)
  }

  /** Opens a native picker for exactly one supported external executable role. */
  async selectExecutable(purpose: ManagedExecutableKind): Promise<ManagedExecutableSelection> {
    assertExecutablePurpose(purpose)
    const selectedPath = await this.#executablePicker.pickExecutable(purpose)
    if (selectedPath === undefined) {
      throw new ManagedRootError(
        'managed.selection_cancelled',
        'Executable selection was cancelled.'
      )
    }
    const canonicalPath = await canonicalizeSelectedExecutable(selectedPath)
    const capability = this.#executableCapabilities.issue(
      purpose,
      canonicalPath,
      nodePath.basename(canonicalPath)
    )
    return {
      capabilityId: capability.capabilityId,
      purpose: capability.purpose,
      displayName: capability.displayName
    }
  }

  /** Registers one capability-selected Git, Node, and pnpm triple before persisting it as a toolchain. */
  async registerToolchain(
    request: RegisterManagedToolchainRequest
  ): Promise<RegisterManagedToolchainResult> {
    return this.#runExclusive(async () => {
      const selections = this.#inspectToolchainSelections(request)
      const consumed = {
        git: this.#executableCapabilities.consume(selections.git.capabilityId, 'git'),
        node: this.#executableCapabilities.consume(selections.node.capabilityId, 'node'),
        pnpm: this.#executableCapabilities.consume(selections.pnpm.capabilityId, 'pnpm')
      }
      const toolchain = await this.#registerToolchainFromSelections(consumed)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      const existing = catalog.toolchains.find((entry) => sameToolchain(entry, toolchain))
      if (existing) {
        return {
          toolchainId: existing.toolchainId,
          state: projectInstallationsState(catalog, this.#runtimeSupervisor)
        }
      }
      const next: ManagedInstallationCatalog = {
        ...catalog,
        toolchains: [...catalog.toolchains, toolchain]
      }
      await this.#workspaceService.saveInstallationCatalog(next)
      return {
        toolchainId: toolchain.toolchainId,
        state: projectInstallationsState(next, this.#runtimeSupervisor)
      }
    })
  }

  /** Imports the package seed through the same mirror, detached-worktree, and toolchain path as any remote clone. */
  async installBundledSeed(
    request: InstallBundledHarnessSeedRequest
  ): Promise<ManagedInstallationsState> {
    return this.#runExclusive(async () => {
      assertInstallBundledSeedRequest(request)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      if (catalog.installations.some((entry) => entry.workspaceId === request.workspaceId)) {
        throw new ManagedRootError(
          'managed.installation_exists',
          'The selected workspace already owns a managed Harness installation.'
        )
      }
      const seed = await this.#bundledSeedLoader()
      const toolchain = findToolchain(catalog, request.toolchainId)
      const workspace = await this.#workspaceService.getWorkspaceDirectories(request.workspaceId)
      const installationId = newOpaqueId('installation')
      const remote = managedRemote(seed.remoteUrl)
      const selection = selectGitCommit(seed.revision)
      const paths = createManagedGitInstallationPaths(
        workspaceRootPath(workspace, 'harness'),
        installationId
      )
      const context = gitContext(workspaceRootPath(workspace, 'harness'))
      await createManagedGitMirrorFromBundle(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        remote,
        seed.bundlePath
      )
      const resolved = await resolveGitRevision(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        remote,
        selection
      )
      const worktree = await materializeManagedGitWorktree(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        remote,
        resolved.commit
      )
      await this.#worktreePreparer.prepare({
        worktreePath: worktree.path,
        node: toolchain.node,
        pnpm: toolchain.pnpm
      })
      const installation: ManagedHarnessInstallationRecord = {
        installationId,
        workspaceId: workspace.workspace.workspaceId,
        toolchainId: toolchain.toolchainId,
        remote,
        selection: resolved.selection,
        commit: resolved.commit,
        observedReference: resolved.observedReference,
        observedObject: resolved.observedObject,
        ...(resolved.tagObject === undefined ? {} : { tagObject: resolved.tagObject })
      }
      const next: ManagedInstallationCatalog = {
        ...catalog,
        installations: [...catalog.installations, installation]
      }
      await this.#workspaceService.saveInstallationCatalog(next)
      return projectInstallationsState(next, this.#runtimeSupervisor)
    })
  }

  /** Clones exactly one remote into a fresh managed installation and materializes the requested immutable worktree. */
  async cloneHarness(request: CloneManagedHarnessRequest): Promise<ManagedInstallationsState> {
    return this.#runExclusive(async () => {
      assertCloneRequest(request)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      if (catalog.installations.some((entry) => entry.workspaceId === request.workspaceId)) {
        throw new ManagedRootError(
          'managed.installation_exists',
          'The selected workspace already owns a managed Harness installation.'
        )
      }
      const toolchain = findToolchain(catalog, request.toolchainId)
      const workspace = await this.#workspaceService.getWorkspaceDirectories(request.workspaceId)
      const installationId = newOpaqueId('installation')
      const remote = managedRemote(request.remoteUrl)
      const selection = revisionSelection(request.revision)
      const paths = createManagedGitInstallationPaths(
        workspaceRootPath(workspace, 'harness'),
        installationId
      )
      const context = gitContext(workspaceRootPath(workspace, 'harness'))
      await createManagedGitMirror(this.#gitRunner, toolchain.git, context, paths, remote)
      const resolved = await resolveGitRevision(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        remote,
        selection
      )
      const worktree = await materializeManagedGitWorktree(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        remote,
        resolved.commit
      )
      await this.#worktreePreparer.prepare({
        worktreePath: worktree.path,
        node: toolchain.node,
        pnpm: toolchain.pnpm
      })
      const installation: ManagedHarnessInstallationRecord = {
        installationId,
        workspaceId: workspace.workspace.workspaceId,
        toolchainId: toolchain.toolchainId,
        remote,
        selection: resolved.selection,
        commit: resolved.commit,
        observedReference: resolved.observedReference,
        observedObject: resolved.observedObject,
        ...(resolved.tagObject === undefined ? {} : { tagObject: resolved.tagObject })
      }
      const next: ManagedInstallationCatalog = {
        ...catalog,
        installations: [...catalog.installations, installation]
      }
      await this.#workspaceService.saveInstallationCatalog(next)
      return projectInstallationsState(next, this.#runtimeSupervisor)
    })
  }

  /** Fetches one known remote and activates only an exact branch, tag, or commit chosen in this request. */
  async switchRevision(
    request: SwitchManagedHarnessRevisionRequest
  ): Promise<ManagedInstallationsState> {
    return this.#runExclusive(async () => {
      assertSwitchRequest(request)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      const index = catalog.installations.findIndex(
        (entry) =>
          entry.installationId === request.installationId &&
          entry.workspaceId === request.workspaceId
      )
      if (index < 0) {
        throw new ManagedRootError(
          'managed.installation_not_found',
          'Managed Harness installation is not registered for the selected workspace.'
        )
      }
      const installation = catalog.installations[index]
      this.#assertInstallationStopped(installation.installationId)
      const toolchain = findToolchain(catalog, installation.toolchainId)
      const workspace = await this.#workspaceService.getWorkspaceDirectories(request.workspaceId)
      const paths = createManagedGitInstallationPaths(
        workspaceRootPath(workspace, 'harness'),
        installation.installationId
      )
      const context = gitContext(workspaceRootPath(workspace, 'harness'))
      await fetchManagedGitMirror(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        installation.remote
      )
      const selection = revisionSelection(request.revision)
      const resolved = await resolveGitRevision(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        installation.remote,
        selection
      )
      if (
        sameSelection(installation.selection, resolved.selection) &&
        installation.selection.kind !== 'commit'
      ) {
        await assertGitReferenceNotRewritten(
          this.#gitRunner,
          toolchain.git,
          context,
          paths,
          createGitReferenceObservation({
            selection: installation.selection,
            commit: parseGitCommitSha(installation.commit),
            observedReference: installation.observedReference,
            observedObject: installation.observedObject,
            ...(installation.tagObject === undefined ? {} : { tagObject: installation.tagObject })
          }),
          resolved
        )
      }
      const worktree = await materializeOrVerifyWorktree(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        installation.remote,
        resolved.commit
      )
      await this.#worktreePreparer.prepare({
        worktreePath: worktree.path,
        node: toolchain.node,
        pnpm: toolchain.pnpm
      })
      const updated: ManagedHarnessInstallationRecord = {
        ...installation,
        selection: resolved.selection,
        commit: resolved.commit,
        observedReference: resolved.observedReference,
        observedObject: resolved.observedObject,
        ...(resolved.tagObject === undefined ? {} : { tagObject: resolved.tagObject })
      }
      const next: ManagedInstallationCatalog = {
        ...catalog,
        installations: catalog.installations.map((entry, entryIndex) =>
          entryIndex === index ? updated : entry
        )
      }
      await this.#workspaceService.saveInstallationCatalog(next)
      return projectInstallationsState(next, this.#runtimeSupervisor)
    })
  }

  /** Verifies the persisted detached checkout, prepares it with its registered toolchain, then starts its desktop profile. */
  async startHarness(request: StartManagedHarnessRequest): Promise<ManagedInstallationsState> {
    return this.#runExclusive(async () => {
      assertStartRequest(request)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      const installation = catalog.installations.find(
        (entry) =>
          entry.installationId === request.installationId &&
          entry.workspaceId === request.workspaceId
      )
      if (!installation) {
        throw new ManagedRootError(
          'managed.installation_not_found',
          'Managed Harness installation is not registered for the selected workspace.'
        )
      }
      const toolchain = findToolchain(catalog, installation.toolchainId)
      const workspace = await this.#workspaceService.getWorkspaceDirectories(request.workspaceId)
      const paths = createManagedGitInstallationPaths(
        workspaceRootPath(workspace, 'harness'),
        installation.installationId
      )
      const context = gitContext(workspaceRootPath(workspace, 'harness'))
      const worktree = await verifyManagedGitWorktree(
        this.#gitRunner,
        toolchain.git,
        context,
        paths,
        installation.remote,
        parseGitCommitSha(installation.commit)
      )
      await this.#worktreePreparer.prepare({
        worktreePath: worktree.path,
        node: toolchain.node,
        pnpm: toolchain.pnpm
      })
      await this.#runtimeSupervisor.start({
        installationId: installation.installationId,
        launchId: newOpaqueId('launch'),
        node: toolchain.node,
        worktreePath: worktree.path,
        revision: worktree.commit
      })
      return projectInstallationsState(catalog, this.#runtimeSupervisor)
    })
  }

  /** Stops only the active supervised child belonging to the selected registered installation. */
  async stopHarness(request: StopManagedHarnessRequest): Promise<ManagedInstallationsState> {
    return this.#runExclusive(async () => {
      assertStopRequest(request)
      const catalog = await this.#workspaceService.getInstallationCatalog()
      const installation = catalog.installations.find(
        (entry) =>
          entry.installationId === request.installationId &&
          entry.workspaceId === request.workspaceId
      )
      if (!installation) {
        throw new ManagedRootError(
          'managed.installation_not_found',
          'Managed Harness installation is not registered for the selected workspace.'
        )
      }
      await this.#runtimeSupervisor.stop(installation.installationId)
      return projectInstallationsState(catalog, this.#runtimeSupervisor)
    })
  }

  #inspectToolchainSelections(request: RegisterManagedToolchainRequest): Readonly<{
    git: ExecutableSelectionCapability
    node: ExecutableSelectionCapability
    pnpm: ExecutableSelectionCapability
  }> {
    if (!request || typeof request !== 'object') {
      throw new ManagedRootError(
        'managed.selection_invalid',
        'Toolchain registration request is invalid.'
      )
    }
    return {
      git: this.#executableCapabilities.inspect(request.gitCapabilityId, 'git'),
      node: this.#executableCapabilities.inspect(request.nodeCapabilityId, 'node'),
      pnpm: this.#executableCapabilities.inspect(request.pnpmCapabilityId, 'pnpm')
    }
  }

  async #registerToolchainFromSelections(
    selections: Readonly<{
      git: ExecutableSelectionCapability
      node: ExecutableSelectionCapability
      pnpm: ExecutableSelectionCapability
    }>
  ): Promise<ManagedToolchainRecord> {
    return this.#withProbeDirectory(async (probeDirectory) => {
      const git = await registerGitExecutable(
        selections.git.canonicalPath,
        gitContext(probeDirectory),
        GIT_TOOL_POLICY,
        this.#gitRunner
      )
      const node = await registerNodeExecutable(
        selections.node.canonicalPath,
        toolchainContext(probeDirectory)
      )
      const pnpmLauncher = await launcherForPnpm(selections.pnpm.canonicalPath, node)
      const pnpm = await registerPnpmExecutable(selections.pnpm.canonicalPath, pnpmLauncher, {
        ...toolchainContext(probeDirectory),
        configurationFilePath: nodePath.join(probeDirectory, TOOL_PROBE_CONFIGURATION_FILE)
      })
      return { toolchainId: newOpaqueId('toolchain'), git, node, pnpm }
    })
  }

  async #withProbeDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    let temporaryDirectory: string
    try {
      temporaryDirectory = await mkdtemp(
        nodePath.join(this.#temporaryDirectory, 'dsh-launcher-probe-')
      )
    } catch (error) {
      throw new ManagedRootError(
        'managed.toolchain_invalid',
        'Toolchain probe directory could not be created.',
        { cause: error instanceof Error ? error.name : 'unknown' }
      )
    }
    let canonicalDirectory = temporaryDirectory
    try {
      canonicalDirectory = await canonicalProbeDirectory(temporaryDirectory)
      const configuration = await open(
        nodePath.join(canonicalDirectory, TOOL_PROBE_CONFIGURATION_FILE),
        'wx',
        0o600
      )
      await configuration.close()
      const result = await operation(canonicalDirectory)
      await removeProbeDirectory(canonicalDirectory)
      return result
    } catch (error) {
      try {
        await removeProbeDirectory(canonicalDirectory ?? temporaryDirectory)
      } catch (cleanupError) {
        throw new ManagedRootError('managed.toolchain_invalid', 'Toolchain probe cleanup failed.', {
          cause: cleanupError instanceof Error ? cleanupError.name : 'unknown'
        })
      }
      throw error
    }
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#mutationActive) {
      throw new ManagedRootError(
        'managed.operation_in_progress',
        'Another managed installation operation is in progress.'
      )
    }
    this.#mutationActive = true
    try {
      return await operation()
    } finally {
      this.#mutationActive = false
    }
  }

  /** Rejects source mutation while this installation's child still owns its selected worktree. */
  #assertInstallationStopped(installationId: string): void {
    try {
      const state = this.#runtimeSupervisor.launchFor(installationId).state
      if (state !== 'stopped' && state !== 'failed') {
        throw new ManagedRootError(
          'managed.operation_in_progress',
          'Managed Harness revision cannot change while its child process is active.'
        )
      }
    } catch (error) {
      if (error instanceof ManagedHarnessRuntimeError && error.code === 'runtime.not_found') return
      throw error
    }
  }
}

function projectInstallationsState(
  catalog: ManagedInstallationCatalog,
  runtimeSupervisor: ManagedHarnessWebRuntimeSupervisor
): ManagedInstallationsState {
  const toolchains: readonly ManagedToolchainView[] = catalog.toolchains.map((entry) => ({
    toolchainId: entry.toolchainId,
    gitVersion: entry.git.version.text,
    nodeVersion: entry.node.version.text,
    pnpmVersion: entry.pnpm.version.text
  }))
  const installations: readonly ManagedHarnessInstallationView[] = catalog.installations.map(
    (entry) => ({
      installationId: entry.installationId,
      workspaceId: entry.workspaceId,
      toolchainId: entry.toolchainId,
      remoteUrl: entry.remote.source.declaredUrl,
      requestedRevision: requestedRevision(entry.selection),
      resolvedCommit: entry.commit,
      launch: projectRuntimeLaunch(runtimeSupervisor, entry.installationId)
    })
  )
  return { toolchains, installations }
}

/** Projects a missing transient record as stopped; this is expected after the Launcher process starts. */
function projectRuntimeLaunch(
  runtimeSupervisor: ManagedHarnessWebRuntimeSupervisor,
  installationId: string
): RendererManagedHarnessLaunchView {
  try {
    return projectRuntimeLaunchView(runtimeSupervisor.launchFor(installationId))
  } catch (error) {
    if (error instanceof ManagedHarnessRuntimeError && error.code === 'runtime.not_found') {
      return { kind: 'stopped' }
    }
    throw error
  }
}

function projectRuntimeLaunchView(
  view: RuntimeManagedHarnessLaunchView
): RendererManagedHarnessLaunchView {
  if (view.state === 'running') return { kind: 'running', launchId: view.launchId }
  if (view.state === 'failed') return { kind: 'failed', launchId: view.launchId }
  if (view.state === 'stopped') return { kind: 'stopped', launchId: view.launchId }
  return { kind: 'starting', launchId: view.launchId }
}

function requestedRevision(selection: GitRevisionSelection): ManagedRevisionRequest {
  if (selection.kind === 'branch') return { kind: 'branch', value: selection.branch }
  if (selection.kind === 'tag') return { kind: 'tag', value: selection.tag }
  return { kind: 'commit', value: selection.commit }
}

function assertExecutablePurpose(value: unknown): asserts value is ExecutableSelectionPurpose {
  if (value !== 'git' && value !== 'node' && value !== 'pnpm') {
    throw new ManagedRootError(
      'managed.executable_selection_invalid',
      'Executable selection purpose is invalid.'
    )
  }
}

function assertCloneRequest(value: CloneManagedHarnessRequest): void {
  if (
    !value ||
    typeof value.workspaceId !== 'string' ||
    typeof value.toolchainId !== 'string' ||
    typeof value.remoteUrl !== 'string'
  ) {
    throw new ManagedRootError('managed.selection_invalid', 'Managed clone request is invalid.')
  }
}

function assertInstallBundledSeedRequest(value: InstallBundledHarnessSeedRequest): void {
  if (!value || typeof value.workspaceId !== 'string' || typeof value.toolchainId !== 'string') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Bundled seed installation request is invalid.'
    )
  }
}

function assertSwitchRequest(value: SwitchManagedHarnessRevisionRequest): void {
  if (!value || typeof value.workspaceId !== 'string' || typeof value.installationId !== 'string') {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Managed revision switch request is invalid.'
    )
  }
}

function assertStartRequest(value: StartManagedHarnessRequest): void {
  if (!value || typeof value.workspaceId !== 'string' || typeof value.installationId !== 'string') {
    throw new ManagedRootError('managed.selection_invalid', 'Managed start request is invalid.')
  }
}

function assertStopRequest(value: StopManagedHarnessRequest): void {
  if (!value || typeof value.workspaceId !== 'string' || typeof value.installationId !== 'string') {
    throw new ManagedRootError('managed.selection_invalid', 'Managed stop request is invalid.')
  }
}

/** Resolve one immutable Launcher storage root without nesting a Harness install below a workspace. */
function workspaceRootPath(workspace: ResolvedManagedWorkspace, kind: 'harness'): string {
  const root = workspace.roots.find((entry) => entry.kind === kind)
  if (!root) {
    throw new ManagedRootError('managed.invalid_record', 'Managed storage root is unavailable.')
  }
  return root.canonicalPath
}

function revisionSelection(request: ManagedRevisionRequest): GitRevisionSelection {
  if (!request || typeof request !== 'object' || typeof request.value !== 'string') {
    throw new ManagedRootError('managed.git_revision_invalid', 'Managed Git revision is invalid.')
  }
  try {
    if (request.kind === 'branch') return selectGitBranch(request.value)
    if (request.kind === 'tag') return selectGitTag(request.value)
    if (request.kind === 'commit') return selectGitCommit(request.value)
  } catch (error) {
    if (error instanceof GitRuntimeError) {
      throw new ManagedRootError('managed.git_revision_invalid', 'Managed Git revision is invalid.')
    }
    throw error
  }
  throw new ManagedRootError('managed.git_revision_invalid', 'Managed Git revision is invalid.')
}

function managedRemote(url: string) {
  try {
    return createGitNamedRemote('origin', url)
  } catch (error) {
    if (error instanceof GitRuntimeError) {
      throw new ManagedRootError('managed.git_remote_invalid', 'Managed Git remote is invalid.')
    }
    throw error
  }
}

function findToolchain(
  catalog: ManagedInstallationCatalog,
  toolchainId: string
): ManagedToolchainRecord {
  const toolchain = catalog.toolchains.find((entry) => entry.toolchainId === toolchainId)
  if (!toolchain) {
    throw new ManagedRootError(
      'managed.toolchain_not_found',
      'Managed toolchain is not registered.'
    )
  }
  return toolchain
}

function gitContext(workingDirectory: string): GitExecutionContext {
  return {
    workingDirectory,
    environment: platformGitEnvironment(),
    timeoutMilliseconds: 120_000,
    maximumOutputBytes: 1_048_576
  }
}

function toolchainContext(workingDirectory: string): ToolchainProcessContext {
  return {
    workingDirectory,
    environment: platformToolchainEnvironment(),
    timeoutMilliseconds: 30_000,
    maximumOutputBytes: 64 * 1024
  }
}

function platformGitEnvironment(): Readonly<Record<string, string>> {
  return createGitExecutionEnvironment(platformEnvironmentOptions())
}

function platformToolchainEnvironment(): Readonly<Record<string, string>> {
  return createToolchainExecutionEnvironment(platformEnvironmentOptions())
}

function platformEnvironmentOptions(): Readonly<{
  platform: NodeJS.Platform
  systemRoot?: string
  windir?: string
  comspec?: string
  pathExt?: string
}> {
  if (process.platform !== 'win32') return { platform: process.platform }
  return {
    platform: process.platform,
    systemRoot: process.env.SYSTEMROOT ?? process.env.SystemRoot,
    windir: process.env.WINDIR,
    comspec: process.env.COMSPEC,
    pathExt: process.env.PATHEXT
  }
}

async function canonicalProbeDirectory(path: string): Promise<string> {
  try {
    const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(path))
    const metadata = await lstat(canonical)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ManagedRootError(
        'managed.toolchain_invalid',
        'Toolchain probe directory is invalid.'
      )
    }
    return canonical
  } catch (error) {
    if (error instanceof ManagedRootError) throw error
    throw new ManagedRootError(
      'managed.toolchain_invalid',
      'Toolchain probe directory is unavailable.',
      {
        cause: error instanceof Error ? error.name : 'unknown'
      }
    )
  }
}

async function removeProbeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false })
}

async function launcherForPnpm(
  pnpmPath: string,
  node: NodeExecutableRegistration
): Promise<PnpmExecutableLauncher> {
  const extension = nodePath.extname(pnpmPath).toLocaleLowerCase('en-US')
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return { kind: 'node-script', node }
  }
  let prefix: string
  try {
    prefix = (await readFile(pnpmPath, 'utf8')).slice(0, 1_024)
  } catch (error) {
    throw new ManagedRootError('managed.toolchain_invalid', 'Selected pnpm entry cannot be read.', {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
  return /^#!.*\bnode(?:\s|$)/u.test(prefix) ? { kind: 'node-script', node } : { kind: 'native' }
}

async function materializeOrVerifyWorktree(
  runner: GitCommandRunner,
  git: ManagedToolchainRecord['git'],
  context: GitExecutionContext,
  paths: ReturnType<typeof createManagedGitInstallationPaths>,
  remote: ManagedHarnessInstallationRecord['remote'],
  commit: string
) {
  const target = managedWorktreePath(paths, commit)
  try {
    await lstat(target)
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) {
      return materializeManagedGitWorktree(
        runner,
        git,
        context,
        paths,
        remote,
        parseGitCommitSha(commit)
      )
    }
    throw error
  }
  return verifyManagedGitWorktree(runner, git, context, paths, remote, parseGitCommitSha(commit))
}

function sameToolchain(left: ManagedToolchainRecord, right: ManagedToolchainRecord): boolean {
  return (
    JSON.stringify({ git: left.git, node: left.node, pnpm: left.pnpm }) ===
    JSON.stringify({ git: right.git, node: right.node, pnpm: right.pnpm })
  )
}

function sameSelection(left: GitRevisionSelection, right: GitRevisionSelection): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'branch' && right.kind === 'branch') return left.branch === right.branch
  if (left.kind === 'tag' && right.kind === 'tag') return left.tag === right.tag
  return left.kind === 'commit' && right.kind === 'commit' && left.commit === right.commit
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
