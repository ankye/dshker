import { appendFile, copyFile, stat } from 'node:fs/promises'
import {
  type LauncherHarnessConsoleEntry,
  type LauncherHarnessLogFileView,
  type LauncherHarnessPluginView,
  type LauncherHarnessPortSetting,
  type LauncherHarnessState
} from '../../../src/shared/contracts'
import { randomUUID } from 'node:crypto'
import type {
  CoreHarnessLaunchRequest,
  CoreHarnessLaunchView,
  CoreHarnessRuntimePort,
  CoreHarnessState
} from '../core/harness-runtime'
import { LauncherRuntimeFeed } from './launcher-runtime-feed'
import { launchFailureEventText } from './launch-failure'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import {
  launcherProfilePluginArguments,
  pnpmCommandEnvironment,
  resolvePnpmCommand,
  launcherGitArguments
} from './launcher-harness-commands'
import {
  classifyChildConsoleStream,
  describePluginInstallSource,
  formatLauncherLifecycleEvent
} from './launcher-console-format'
import {
  readHarnessReadiness,
  assertLauncherGitRepository,
  readLauncherBranches,
  readProfilePluginViews,
  tryReadLauncherCheckoutMetadata
} from './launcher-harness-views'
import { LauncherOperationReporter } from './launcher-operation-reporter'
import {
  materializeLauncherVersion,
  pruneInactiveVersions,
  readCurrentVersionPointer,
  versionDirectory
} from './launcher-version-store'
import { terminateManagedProcessTree } from './process-tree'
import { runText } from './process-utils'
import { localGitHubPluginSource } from './legacy-plugin-source'
import { ManagedPluginSources, type ManagedPluginInstallSource } from './managed-plugin-sources'
import { assertPortSetting } from './launch-preferences'

/** A plugin command may resolve locally, but must never leave the UI busy indefinitely. */
const PLUGIN_COMMAND_TIMEOUT_MILLISECONDS = 120_000

/**
 * The one DSH Web subject this service owns.
 *
 * The core keys a launch by subject, and the Launcher has exactly one native web
 * profile, so a second launch is refused by the core as an operation in
 * progress rather than by a shell-side flag.
 */
export const LAUNCHER_HARNESS_SUBJECT = 'launcher-harness'

export {
  githubTreePluginUrl,
  parseManagedGitSource,
  type ManagedPluginInstallSource
} from './managed-plugin-sources'
export { parseAnnouncedWebUrl } from './announced-web-url'
export { assertPortSetting } from './launch-preferences'
export {
  gitUrlOf,
  localPathOf,
  normalizeGitRemote,
  parseProfilePluginRecords
} from './profile-plugins'
export {
  classifyChildConsoleStream,
  describePluginInstallSource,
  formatLauncherLifecycleEvent,
  formatLauncherOperationFailure,
  formatLauncherStepCompletion,
  formatLauncherStepHeartbeat
} from './launcher-console-format'

/** Inputs for the single Launcher-owned Harness checkout. */
export interface LauncherHarnessServiceOptions {
  /** Main Git repository: history, refs, and fetch target; never built in place. */
  readonly harnessDirectory: string
  /** Per-version worktrees: one directory per exact commit, built in isolation. */
  readonly versionsDirectory: string
  /** Atomically-flipped pointer naming the active version's commit. */
  readonly currentVersionPointerPath: string
  /** Launcher-owned root for cloned and copied plugin sources. */
  readonly pluginSourcesDirectory: string
  readonly dshHomeDirectory: string
  /** Launcher-owned preferences outside the checkout, retained across revision switches. */
  readonly launchPreferencesPath: string
  /**
   * File receiving the full stdout and stderr of the launched DSH Web process.
   *
   * The in-memory console keeps only the newest 1000 fragments, so a failure
   * that scrolls past that cap survives only here. It sits beside the launch
   * preferences, outside the checkout, so switching revisions never removes the
   * evidence of the launch that just failed.
   */
  readonly launchLogPath: string
  /** Launcher-owned DSH overlay enabling detailed Cordis startup diagnostics for this child only. */
  readonly diagnosticsPatchPath: string
  readonly gitExecutable: string
  readonly pnpmExecutable: string
  /** Direct pnpm command for platforms whose registered pnpm is a shell shim. */
  readonly pnpmLauncher?: Readonly<{
    /** Set when the packaged pnpm could not be resolved; the launch is refused with it. */
    readonly resolutionError?: string
    readonly executable: string
    readonly prefixArguments: readonly string[]
    /** PATH required by pnpm's shell entrypoint and its subprocesses. */
    readonly commandSearchPath: string
  }>
  /**
   * The core's DSH Web child, which now owns the process, the port and the log.
   *
   * A shell without a core has no runtime at all: the service refuses with
   * `managed.core_unavailable` rather than spawning its own second copy, which
   * is what keeps exactly one writer for this process.
   */
  readonly runtime?: () => CoreHarnessRuntimePort | undefined
}

/** Starts the packaged checkout without changing its native DSH configuration. */
export class LauncherHarnessService {
  readonly #options: LauncherHarnessServiceOptions
  readonly #pluginSources: ManagedPluginSources
  /** Operation start/step/failure records on the console feed and durable log. */
  readonly #operations: LauncherOperationReporter
  #launchState: LauncherHarnessState['launch'] = { kind: 'stopped' }
  readonly #launchListeners = new Set<(state: LauncherHarnessState['launch']) => void>()
  get #launch(): LauncherHarnessState['launch'] {
    return this.#launchState
  }
  set #launch(state: LauncherHarnessState['launch']) {
    this.#launchState = Object.freeze({ ...state })
    for (const listener of this.#launchListeners) listener(this.#launchState)
  }
  /** Main-owned lifecycle feed; no renderer authority or guessed runtime endpoint. */
  getRuntimeState(): LauncherHarnessState['launch'] {
    return this.#launchState
  }
  onRuntimeState(listener: (state: LauncherHarnessState['launch']) => void): () => void {
    this.#launchListeners.add(listener)
    return () => {
      this.#launchListeners.delete(listener)
    }
  }
  /** Follows the core's launch record and console feed while one is live. */
  readonly #feed = new LauncherRuntimeFeed({
    runtime: () => this.#runtime(),
    subjectId: LAUNCHER_HARNESS_SUBJECT,
    onConsole: (stream, text) => this.#appendConsoleEntry(stream, text),
    onLaunch: (view) => this.#applyLaunchView(view)
  })
  /** Bounded activity feed: Launcher operations, their child output, and the DSH Web launch. */
  #console: LauncherHarnessConsoleEntry[] = []
  /** Monotonic console sequence; append events and snapshots are unioned by it. */
  #consoleSeq = 0
  /** Timestamp of the newest console entry; heartbeat steps read it to stay quiet. */
  #lastConsoleAppendAt = 0
  /** Listeners notified once per appended entry; Electron IPC wiring is the only subscriber. */
  readonly #consoleListeners = new Set<(entry: LauncherHarnessConsoleEntry) => void>()
  #port: LauncherHarnessPortSetting = { mode: 'auto' }
  #portLoaded = false
  #bootstrap: 'preparing' | { readonly kind: 'failed'; readonly message: string } | undefined

  constructor(options: LauncherHarnessServiceOptions) {
    this.#options = options
    this.#pluginSources = new ManagedPluginSources({
      pluginsDirectory: options.pluginSourcesDirectory,
      gitExecutable: options.gitExecutable
    })
    this.#operations = new LauncherOperationReporter({
      launchLogPath: options.launchLogPath,
      emit: (message) =>
        this.#appendConsoleEntry('launcher', formatLauncherLifecycleEvent(message)),
      lastConsoleAppendAt: () => this.#lastConsoleAppendAt
    })
  }
  /** Records package initialization progress without changing the Harness checkout. */
  setBootstrapState(
    state: 'preparing' | { readonly kind: 'failed'; readonly message: string } | undefined
  ): void {
    this.#bootstrap = state
    // Bootstrap runs before any checkout exists, so these events are often the
    // only thing the Console can show while the first DSH install is working.
    if (state === 'preparing') {
      this.#appendLauncherEvent('Preparing the bundled DSH (first-run package installation).')
      return
    }
    if (state === undefined) {
      this.#appendLauncherEvent('Bundled DSH preparation completed.')
      return
    }
    this.#appendLauncherEvent(`Bundled DSH preparation failed: ${state.message}`)
  }
  /** Records one step performed outside this service, such as bundled-seed preparation. */
  recordOperationActivity(message: string): void {
    this.#appendLauncherEvent(message)
  }
  /**
   * Subscribes to every console entry appended after subscription.
   *
   * Returns the unsubscribe function. The service stays Electron-free; the IPC
   * layer forwards these entries as the main-to-renderer push channel.
   */
  onConsoleAppend(listener: (entry: LauncherHarnessConsoleEntry) => void): () => void {
    this.#consoleListeners.add(listener)
    return () => {
      this.#consoleListeners.delete(listener)
    }
  }
  /** Returns only facts read from the Launcher checkout and the native DSH web profile. */
  async getState(): Promise<LauncherHarnessState> {
    await this.#loadPort()
    if (this.#bootstrap !== undefined) {
      const preparing = this.#bootstrap === 'preparing'
      return {
        ...(await this.#stateTail()),
        kind: preparing ? 'preparing' : 'invalid',
        message: preparing
          ? 'The bundled DSH is being prepared.'
          : (this.#bootstrap as { readonly message: string }).message
      }
    }
    const active = await this.#activeVersion()
    if (active === undefined) {
      // No active version yet: distinguish a repository that was never created
      // (fresh install before the seed) from one awaiting its first version.
      let repositoryExists = false
      try {
        await assertLauncherGitRepository(this.#options.harnessDirectory)
        repositoryExists = true
      } catch {
        repositoryExists = false
      }
      const base = {
        ...(await this.#stateTail()),
        kind: (repositoryExists ? 'invalid' : 'missing') as 'invalid' | 'missing'
      }
      return repositoryExists
        ? {
            ...base,
            message: 'The active DSH version has not been prepared yet.'
          }
        : {
            ...base,
            message: 'The Launcher Harness directory has not been initialized.'
          }
    }
    const readiness = await readHarnessReadiness(active.directory)
    if (readiness.kind !== 'ready') {
      return {
        ...(await this.#stateTail()),
        ...readiness
      }
    }
    // Version history comes from the main repository; the active worktree names
    // the revision the pointer selected, which is what the UI marks as current.
    const [metadata, plugins] = await Promise.all([
      tryReadLauncherCheckoutMetadata(this.#options.gitExecutable, this.#options.harnessDirectory),
      readProfilePluginViews(
        this.#options.gitExecutable,
        this.#options.dshHomeDirectory,
        this.#pluginSources
      )
    ])
    return {
      kind: 'ready',
      harnessDirectory: active.directory,
      remoteUrl: metadata.remoteUrl ?? '',
      currentBranch: metadata.currentBranch ?? 'master',
      branches: metadata.branches,
      revision: active.commit,
      launch: this.#launch,
      port: this.#port,
      commits: metadata.commits,
      stableVersions: metadata.stableVersions,
      plugins,
      console: this.#console,
      logFile: await this.#logFileView()
    }
  }
  /** Shared tail for every non-ready state: recovery metadata keeps the version list usable. */
  async #stateTail() {
    const metadata = await tryReadLauncherCheckoutMetadata(
      this.#options.gitExecutable,
      this.#options.harnessDirectory
    )
    return {
      harnessDirectory: this.#options.harnessDirectory,
      launch: this.#launch,
      port: this.#port,
      remoteUrl: metadata.remoteUrl,
      currentBranch: metadata.currentBranch,
      branches: metadata.branches,
      revision: metadata.revision,
      commits: metadata.commits,
      stableVersions: metadata.stableVersions,
      plugins: [] as const,
      console: this.#console,
      logFile: await this.#logFileView()
    }
  }
  /** Reports the log path whether or not a launch has created the file yet. */
  async #logFileView(): Promise<LauncherHarnessLogFileView> {
    try {
      const metadata = await stat(this.#options.launchLogPath)
      return { path: this.#options.launchLogPath, exists: true, byteLength: metadata.size }
    } catch {
      // Absent before the first launch: the path is still the answer the user needs.
      return { path: this.#options.launchLogPath, exists: false, byteLength: 0 }
    }
  }
  /**
   * Reveals the log in the OS file manager.
   *
   * The path is service-owned rather than renderer-supplied, so the renderer
   * cannot ask the main process to reveal an arbitrary location.
   */
  async revealLog(showItemInFolder: (target: string) => void): Promise<LauncherHarnessLogFileView> {
    const view = await this.#logFileView()
    if (!view.exists) {
      throw new ManagedHarnessRuntimeError(
        'runtime.not_found',
        'No launch log exists yet; start DSH Web first.'
      )
    }
    showItemInFolder(view.path)
    return view
  }
  /** Copies the log to a caller-chosen destination; the service never picks the path. */
  async exportLog(destination: string): Promise<LauncherHarnessLogFileView> {
    const view = await this.#logFileView()
    if (!view.exists) {
      throw new ManagedHarnessRuntimeError(
        'runtime.not_found',
        'No launch log exists yet; start DSH Web first.'
      )
    }
    await copyFile(view.path, destination)
    return view
  }
  /** Fetches only remote refs before rebuilding the visible version candidates. */
  async refreshVersions(): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation('Refreshing the DSH version list', async () => {
      await this.#assertSwitchableRepository()
      await this.#fetchOrigin()
      return this.getState()
    })
  }
  /** Switches the active version to the newest fetched master commit. */
  async update(): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(
      'Updating DSH to the newest origin/master commit',
      async () => {
        await this.#assertSwitchableRepository()
        await this.#fetchOrigin()
        const commit = (
          await runText(
            this.#options.gitExecutable,
            launcherGitArguments([
              '-C',
              this.#options.harnessDirectory,
              'rev-parse',
              'origin/master'
            ])
          )
        ).trim()
        await this.#materializeVersion(commit)
        return this.getState()
      }
    )
  }
  /**
   * Materializes the main repository's current commit as the first version.
   *
   * Migration path for checkouts created before per-version directories: the
   * existing repository stays the history source and its working tree is left
   * untouched; the active version simply becomes a worktree of its HEAD.
   */
  async prepareCurrentVersion(): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(
      'Preparing the active DSH version from the existing repository',
      async () => {
        await this.#assertSwitchableRepository()
        if (
          (await readCurrentVersionPointer(this.#options.currentVersionPointerPath)) !== undefined
        ) {
          return this.getState()
        }
        const commit = (
          await runText(
            this.#options.gitExecutable,
            launcherGitArguments(['-C', this.#options.harnessDirectory, 'rev-parse', 'HEAD'])
          )
        ).trim()
        await this.#materializeVersion(commit)
        return this.getState()
      }
    )
  }
  /** Copies or clones a source under Launcher control, then installs that copy through DSH. */
  async installPlugin(source: ManagedPluginInstallSource): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(
      `Installing ${describePluginInstallSource(source)}`,
      async () => {
        await this.#assertReadyForVersionOperation()
        const before = await this.#pluginViews()
        const materialized = await this.#pluginSources.materialize(source)
        let pluginCommandSucceeded = false
        try {
          await this.#runPluginCommand(
            launcherProfilePluginArguments('add', `file:${materialized.installDirectory}`)
          )
          pluginCommandSucceeded = true
          const after = await this.#pluginViews()
          const installed = after.filter(
            (plugin) =>
              plugin.origin === 'user' && !before.some((previous) => previous.name === plugin.name)
          )
          if (installed.length !== 1) {
            throw new ManagedHarnessRuntimeError(
              'runtime.plugin_operation_failed',
              'DSH did not report exactly one newly installed plugin.'
            )
          }
          await this.#pluginSources.record(installed[0].name, materialized)
          return this.getState()
        } catch (error) {
          // Once DSH accepted the source, its native profile can reference it. Do
          // not remove the directory if a later profile inspection or source-map
          // write fails, or that profile would be left pointing at a missing path.
          if (!pluginCommandSucceeded) {
            await this.#pluginSources.discard(materialized.managedDirectory)
          }
          throw error
        }
      }
    )
  }
  /** Extracts one native-selected plugin ZIP into Launcher ownership, then installs it through DSH. */
  async installPluginArchive(archivePath: string): Promise<LauncherHarnessState> {
    return this.installPlugin({ kind: 'archive', path: archivePath })
  }
  /** Fetches managed Git sources to calculate update availability without changing DSH's profile. */
  async refreshPlugins(): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(
      'Checking managed plugin sources for updates',
      async () => {
        await this.#pluginSources.refreshGitSourceStatus()
        return this.getState()
      }
    )
  }
  /** Removes exactly one user-installed plugin from the native web profile via the DSH CLI. */
  async uninstallPlugin(name: string): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(`Removing plugin ${name}`, async () => {
      if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(name) || name.length === 0) {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'A valid plugin package name is required.'
        )
      }
      await this.#assertReadyForVersionOperation()
      const plugins = await this.#pluginViews()
      const target = plugins.find((plugin) => plugin.name === name)
      if (target === undefined || target.origin !== 'user') {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'Only a user-installed plugin can be removed.'
        )
      }
      await this.#runPluginCommand(launcherProfilePluginArguments('remove', name))
      await this.#pluginSources.remove(name)
      return this.getState()
    })
  }
  /** Updates exactly one Git-managed plugin source, then lets DSH reconcile that package. */
  async updatePlugin(name: string): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(`Updating plugin ${name}`, async () => {
      if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(name) || name.length === 0) {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'A valid plugin package name is required.'
        )
      }
      await this.#assertReadyForVersionOperation()
      const plugins = await this.#pluginViews()
      const target = plugins.find((plugin) => plugin.name === name)
      if (target === undefined || target.origin !== 'user') {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'Only a user-installed plugin can be updated.'
        )
      }
      await this.#pluginSources.update(name)
      await this.#runPluginCommand(launcherProfilePluginArguments('update', name))
      return this.getState()
    })
  }
  /**
   * Moves one legacy local Git plugin into a Launcher-owned clone, then asks
   * DSH to use that clone as its installed source. The native profile remains
   * the only installation authority.
   */
  async adoptPlugin(name: string): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(
      `Moving plugin ${name} under DSHKer management`,
      async () => {
        this.#assertPluginName(name)
        await this.#assertReadyForVersionOperation()
        const plugins = await this.#pluginViews()
        const target = plugins.find((plugin) => plugin.name === name)
        if (target === undefined || target.origin !== 'user') {
          throw new ManagedHarnessRuntimeError(
            'runtime.input_invalid',
            'Only a user-installed plugin can be moved under DSHKer management.'
          )
        }
        if (target.managedGitSource !== undefined) {
          throw new ManagedHarnessRuntimeError(
            'runtime.input_invalid',
            'This plugin is already managed by DSHKer. Use update instead.'
          )
        }

        const materialized = await this.#pluginSources.materialize({
          kind: 'git',
          url: await localGitHubPluginSource(this.#options.gitExecutable, target)
        })
        let pluginCommandSucceeded = false
        try {
          await this.#runPluginCommand(
            launcherProfilePluginArguments('add', `file:${materialized.installDirectory}`)
          )
          pluginCommandSucceeded = true
          const after = await this.#pluginViews()
          const installed = after.find((plugin) => plugin.name === name && plugin.origin === 'user')
          if (installed === undefined) {
            throw new ManagedHarnessRuntimeError(
              'runtime.plugin_operation_failed',
              'DSH did not retain the moved plugin in its native profile.'
            )
          }
          await this.#pluginSources.record(name, materialized)
          return this.getState()
        } catch (error) {
          if (!pluginCommandSucceeded) {
            await this.#pluginSources.discard(materialized.managedDirectory)
          }
          throw error
        }
      }
    )
  }
  /**
   * Runs one DSH plugin CLI command, reporting a CLI refusal as a plugin
   * failure rather than a launch failure.
   */
  async #runPluginCommand(arguments_: readonly string[], workingDirectory?: string): Promise<void> {
    try {
      await this.#runPnpm(arguments_, {
        workingDirectory,
        detached: process.platform !== 'win32',
        timeoutMilliseconds: PLUGIN_COMMAND_TIMEOUT_MILLISECONDS,
        onTimeout: (processId: number | undefined) =>
          terminateManagedProcessTree(processId, process.platform)
      })
    } catch (error) {
      throw new ManagedHarnessRuntimeError(
        'runtime.plugin_operation_failed',
        error instanceof Error ? error.message : 'The DSH plugin command failed.'
      )
    }
  }
  /** Rejects an invalid package identifier before it becomes a DSH CLI argument. */
  #assertPluginName(name: string): void {
    if (/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(name) && name.length > 0) return
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'A valid plugin package name is required.'
    )
  }
  /** Materializes an explicitly selected commit from origin/master. */
  async switchVersion(commit: string): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(`Switching DSH to commit ${commit}`, async () => {
      if (!/^[0-9a-f]{40}$/u.test(commit)) {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'A complete DSH commit SHA is required.'
        )
      }
      await this.#assertSwitchableRepository()
      await this.#materializeVersion(commit)
      return this.getState()
    })
  }
  /**
   * Builds one exact commit in its own directory and only then flips the
   * active-version pointer; the orchestration lives in the version store.
   */
  async #materializeVersion(commit: string): Promise<void> {
    await materializeLauncherVersion(
      this.#options.gitExecutable,
      this.#options.harnessDirectory,
      this.#options.versionsDirectory,
      this.#options.currentVersionPointerPath,
      commit,
      {
        loggedStep: (description, step) => this.#operations.loggedStep(description, step),
        install: (directory) =>
          this.#runPnpm(['install', '--frozen-lockfile'], { workingDirectory: directory }),
        build: (directory) => this.#runPnpm(['run', 'build'], { workingDirectory: directory }),
        reconcilePlugins: (directory) =>
          this.#runPluginCommand(launcherProfilePluginArguments('update'), directory),
        event: (message) => this.recordOperationActivity(message)
      }
    )
    // Off the critical path: the new version is already active, so old version
    // directories are deleted in the background and retried on the next switch.
    void pruneInactiveVersions(
      this.#options.gitExecutable,
      this.#options.harnessDirectory,
      this.#options.versionsDirectory,
      commit,
      (message) => this.recordOperationActivity(message)
    ).catch((error: unknown) => {
      this.recordOperationActivity(
        `Version cleanup could not start: ${error instanceof Error ? error.message : 'unknown error'}`
      )
    })
  }
  /** Fetches origin refs while streaming git's own progress into the console. */
  async #fetchOrigin(): Promise<void> {
    await this.#operations.loggedStep(
      'Fetching DSH updates from origin (git fetch --prune --tags origin)',
      () =>
        runText(
          this.#options.gitExecutable,
          // --progress forces git's "Receiving objects: X%" onto piped stderr;
          // without it a slow fetch looks identical to a hung one.
          launcherGitArguments([
            '-C',
            this.#options.harnessDirectory,
            'fetch',
            '--progress',
            '--prune',
            '--tags',
            'origin'
          ]),
          { onOutput: (stream, text) => this.#appendProcessOutput(stream, text) }
        )
    )
  }
  /** Runs one pnpm command inside one version directory (the active one by default). */
  async #runPnpm(
    arguments_: readonly string[],
    execution: Readonly<{
      readonly workingDirectory?: string
      readonly detached?: boolean
      readonly timeoutMilliseconds?: number
      readonly onTimeout?: (processId: number | undefined) => void
    }> = {}
  ): Promise<void> {
    const { workingDirectory, ...childExecution } = execution
    const directory = workingDirectory ?? (await this.#requireActiveDirectory())
    const launch = resolvePnpmCommand(
      this.#options.pnpmExecutable,
      this.#options.pnpmLauncher,
      arguments_
    )
    await runText(launch.executable, launch.arguments, {
      cwd: directory,
      env: pnpmCommandEnvironment(this.#options.pnpmLauncher),
      onOutput: (stream, text) => this.#appendProcessOutput(stream, text),
      ...childExecution
    })
  }
  /** Resolves and switches to one branch from the fetched origin branch list. */
  async switchBranch(branch: string): Promise<LauncherHarnessState> {
    return this.#operations.reportOperation(`Switching DSH to branch ${branch}`, async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(branch)) {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'A valid DSH branch is required.'
        )
      }
      await this.#assertSwitchableRepository()
      await this.#fetchOrigin()
      const branches = await readLauncherBranches(
        this.#options.gitExecutable,
        this.#options.harnessDirectory
      )
      if (!branches.includes(branch)) {
        throw new ManagedHarnessRuntimeError(
          'runtime.input_invalid',
          'The selected DSH branch is unavailable.'
        )
      }
      const commit = (
        await runText(
          this.#options.gitExecutable,
          launcherGitArguments([
            '-C',
            this.#options.harnessDirectory,
            'rev-parse',
            `origin/${branch}`
          ])
        )
      ).trim()
      await this.#materializeVersion(commit)
      return this.getState()
    })
  }
  /**
   * Starts the core's DSH Web child from the bundled Harness checkout.
   *
   * The command, the port preflight, the process tree and the log all belong to
   * the core now. This method keeps what only the shell can do: check that the
   * active version is usable, hand the core the packaged pnpm facts and the
   * verbose overlay, and render the record the core answers with.
   */
  async start(): Promise<LauncherHarnessState> {
    // The slot is claimed before the first await: readiness checks are async, so
    // two quick activations would both pass a check placed after them and ask the
    // core for two children.
    if (this.#launch.kind === 'running' || this.#launch.kind === 'starting') {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'DSH Web is already running.'
      )
    }
    this.#launch = { kind: 'starting' }
    // The console is deliberately not cleared here: the install, update, or
    // switch that prepared this launch is the context a failed launch needs, and
    // a running DSH Web is never a reason to erase what came before it.
    this.#appendLauncherEvent('--- New DSH Web launch ---')
    this.#appendLauncherEvent('Checking the selected Harness checkout and launch settings.')
    let request: CoreHarnessLaunchRequest
    try {
      await this.#loadPort()
      const active = await this.#requireActiveVersion()
      const readiness = await readHarnessReadiness(active.directory)
      if (readiness.kind !== 'ready') {
        throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
      }
      request = {
        launchId: randomUUID(),
        subjectId: LAUNCHER_HARNESS_SUBJECT,
        directory: active.directory,
        profile: 'pnpm',
        nodeExecutable: '',
        pnpmExecutable: this.#options.pnpmExecutable,
        pnpmPrefixArguments: this.#options.pnpmLauncher?.prefixArguments ?? [],
        pnpmResolutionError: this.#options.pnpmLauncher?.resolutionError ?? '',
        pnpmCommandSearchPath: this.#options.pnpmLauncher?.commandSearchPath ?? '',
        diagnosticsPatchPath: this.#options.diagnosticsPatchPath,
        port: this.#port,
        logPath: this.#options.launchLogPath
      }
    } catch (error) {
      // A failed precondition must release the slot it just claimed.
      this.#appendLauncherEvent(
        'Launch preflight failed: ' + (error instanceof Error ? error.message : 'unknown error')
      )
      this.#launch = { kind: 'stopped' }
      throw error
    }
    let view: CoreHarnessLaunchView
    try {
      view = await (await this.#runtime()).start(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      this.#appendLauncherEvent(
        'DSH Web process could not be created: ' + launchFailureEventText(message)
      )
      this.#launch = {
        kind: 'failed',
        message: error instanceof Error ? error.message : 'DSH Web could not start.'
      }
      throw error
    }
    this.#appendLauncherEvent(
      'Started the managed DSH Web child' +
        (view.pid === undefined ? '' : ' (pid=' + String(view.pid) + ')') +
        '; waiting for its URL announcement.'
    )
    this.#applyLaunchView(view)
    this.#feed.start()
    return this.getState()
  }
  /** The core owns the child, so a shell without one has no runtime at all. */
  async #runtime(): Promise<CoreHarnessRuntimePort> {
    const runtime = this.#options.runtime?.()
    if (runtime === undefined) {
      throw new ManagedHarnessRuntimeError(
        'runtime.child_unavailable',
        'The headless core is required to run DSH Web.'
      )
    }
    return runtime
  }
  /** Renders one core launch record as the renderer's launch view. */
  #applyLaunchView(view: CoreHarnessLaunchView): void {
    const state: CoreHarnessState = view.state
    if (state === 'starting') {
      this.#launch = { kind: 'starting' }
      return
    }
    if (state === 'running') {
      if (view.url === undefined) {
        this.#launch = { kind: 'starting' }
        return
      }
      const announced = this.#launch.kind !== 'running' || this.#launch.url !== view.url
      this.#launch = { kind: 'running', url: view.url }
      if (announced) {
        this.#appendLauncherEvent('DSH Web announced its loopback URL; runtime is ready.')
      }
      return
    }
    if (state === 'failed') {
      this.#launch = {
        kind: 'failed',
        message: view.failure?.message ?? 'DSH Web exited unexpectedly.'
      }
      return
    }
    this.#launch = { kind: 'stopped' }
  }
  /**
   * Records the port the next launch will request.
   *
   * A running child keeps its current port: the setting takes effect on the next
   * start, because DSH binds its port at startup. The core owns the document, so
   * a shell without one refuses rather than writing a second copy.
   */
  async setPort(port: LauncherHarnessPortSetting): Promise<LauncherHarnessState> {
    await this.#loadPort()
    this.#port = assertPortSetting(port)
    const runtime = await this.#runtime()
    this.#port = await runtime.portSet(this.#options.launchPreferencesPath, this.#port)
    return this.getState()
  }
  /**
   * Reads the persisted port, with the core as its only reader.
   *
   * A state read must render without a core — the log path, the console and the
   * launch record are all the shell's own — so an unreachable core leaves the
   * automatic default in place and the next launch retries and refuses properly
   * instead of pretending the setting is gone.
   */
  async #loadPort(): Promise<void> {
    if (this.#portLoaded) return
    try {
      const runtime = await this.#runtime()
      this.#port = await runtime.portGet(this.#options.launchPreferencesPath)
      this.#portLoaded = true
    } catch {
      // Reported by the operation that needs the core, not by a state read.
    }
  }
  /** Records one lifecycle event generated by the Launcher rather than the child process. */
  #appendLauncherEvent(message: string): void {
    // The core owns the launch log now, so a Launcher event is a console record:
    // writing the file from two processes would interleave two orderings.
    this.#appendConsoleEntry('launcher', formatLauncherLifecycleEvent(message))
  }
  /**
   * Mirrors one operation child's output fragment into the log and live console.
   *
   * Plugin operations still run in the shell, and their output is what the log
   * keeps for a failed step, so this one path still appends to the file. A launch
   * truncates it, exactly as the shell's own launch always did.
   */
  #appendProcessOutput(stream: 'stdout' | 'stderr', text: string): void {
    if (text.length === 0) return
    void appendFile(this.#options.launchLogPath, text, 'utf8').catch(() => undefined)
    // The same classification as the launch child: pnpm's `$ command` echoes
    // stay recognizable as commands even though pnpm writes them to stderr.
    this.#appendConsoleEntry(classifyChildConsoleStream(stream, text), text)
  }
  /** Keeps the in-memory diagnostics bounded independently of the on-disk log. */
  #appendConsoleEntry(stream: LauncherHarnessConsoleEntry['stream'], text: string): void {
    const entry: LauncherHarnessConsoleEntry = {
      stream,
      occurredAt: Date.now(),
      text,
      seq: ++this.#consoleSeq
    }
    this.#lastConsoleAppendAt = entry.occurredAt
    this.#console.push(entry)
    if (this.#console.length > 1_000) this.#console.splice(0, this.#console.length - 1_000)
    for (const listener of this.#consoleListeners) listener(entry)
  }
  /** Stops the exact DSH process tree the core created for this service. */
  async stop(): Promise<LauncherHarnessState> {
    if (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting') {
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'DSH Web is not running.')
    }
    this.#appendLauncherEvent('Stopping the managed DSH Web process tree.')
    const view = await (await this.#runtime()).stop(LAUNCHER_HARNESS_SUBJECT)
    this.#applyLaunchView(view)
    this.#feed.stop()
    return this.getState()
  }
  /** Stops the active DSH tree before Electron relinquishes main-process ownership. */
  async shutdown(): Promise<void> {
    if (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting') return
    this.#feed.stop()
    this.#appendLauncherEvent('Launcher is shutting down the managed DSH Web process tree.')
    try {
      const view = await (await this.#runtime()).stop(LAUNCHER_HARNESS_SUBJECT)
      this.#applyLaunchView(view)
    } catch {
      // Shutdown must not fail on a core that is already gone.
    }
  }
  /** The active version's commit and directory, or undefined before the first switch. */
  async #activeVersion(): Promise<Readonly<{ commit: string; directory: string }> | undefined> {
    const commit = await readCurrentVersionPointer(this.#options.currentVersionPointerPath)
    if (commit === undefined) return undefined
    return { commit, directory: versionDirectory(this.#options.versionsDirectory, commit) }
  }
  /** The active version's directory; a missing pointer is a typed failure. */
  async #requireActiveVersion(): Promise<Readonly<{ commit: string; directory: string }>> {
    const active = await this.#activeVersion()
    if (active === undefined) {
      throw new ManagedHarnessRuntimeError(
        'runtime.worktree_invalid',
        'The active DSH version has not been prepared yet.'
      )
    }
    return active
  }

  async #requireActiveDirectory(): Promise<string> {
    return (await this.#requireActiveVersion()).directory
  }
  /**
   * Version operations need the main Git repository and a stopped child — the
   * built artifact belongs to per-version directories, not to the main
   * repository, so an unbuilt active version can be repaired by switching.
   */
  async #assertSwitchableRepository(): Promise<void> {
    if (this.#launch.kind === 'running' || this.#launch.kind === 'starting') {
      throw new ManagedHarnessRuntimeError(
        'runtime.busy_running',
        'Stop DSH Web before changing its version or plugins.'
      )
    }
    try {
      await assertLauncherGitRepository(this.#options.harnessDirectory)
    } catch (error) {
      throw new ManagedHarnessRuntimeError(
        'runtime.worktree_invalid',
        error instanceof Error ? error.message : 'The Launcher Harness directory is unavailable.'
      )
    }
  }
  /** Plugin operations run the DSH CLI, which needs the built active version. */
  async #assertReadyForVersionOperation(): Promise<void> {
    await this.#assertSwitchableRepository()
    const active = await this.#requireActiveVersion()
    const readiness = await readHarnessReadiness(active.directory)
    if (readiness.kind !== 'ready') {
      throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
    }
  }
  /** Reads the native profile's plugin views joined with Launcher-managed sources. */
  #pluginViews(): Promise<readonly LauncherHarnessPluginView[]> {
    return readProfilePluginViews(
      this.#options.gitExecutable,
      this.#options.dshHomeDirectory,
      this.#pluginSources
    )
  }
}
