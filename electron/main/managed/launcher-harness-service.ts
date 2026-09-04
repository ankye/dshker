import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import {
  type LauncherHarnessConsoleEntry,
  type LauncherHarnessLogFileView,
  type LauncherHarnessPluginView,
  type LauncherHarnessPortSetting,
  type LauncherHarnessState
} from '../../../src/shared/contracts'
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
  formatLauncherLifecycleEvent,
  launcherWebStartArguments
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
import { ChildOutputObserver } from './child-output-observer'
import { terminateManagedChild } from './child-termination'
import { ManagedPluginSources, type ManagedPluginInstallSource } from './managed-plugin-sources'
import {
  assertPortSetting,
  LAUNCH_PREFERENCES_FORMAT,
  parseLaunchPreferencesPort
} from './launch-preferences'

/** A plugin command may resolve locally, but must never leave the UI busy indefinitely. */
const PLUGIN_COMMAND_TIMEOUT_MILLISECONDS = 120_000

export {
  githubTreePluginUrl,
  parseManagedGitSource,
  type ManagedPluginInstallSource
} from './managed-plugin-sources'
export { parseAnnouncedWebUrl } from './announced-web-url'
export {
  assertPortSetting,
  LAUNCH_PREFERENCES_FORMAT,
  parseLaunchPreferencesPort
} from './launch-preferences'
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
  formatLauncherStepHeartbeat,
  launcherWebStartArguments
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
    readonly executable: string
    readonly prefixArguments: readonly string[]
    /** PATH required by pnpm's shell entrypoint and its subprocesses. */
    readonly commandSearchPath: string
  }>
}

/** Starts the packaged checkout without changing its native DSH configuration. */
export class LauncherHarnessService {
  readonly #options: LauncherHarnessServiceOptions
  readonly #pluginSources: ManagedPluginSources
  /** Operation start/step/failure records on the console feed and durable log. */
  readonly #operations: LauncherOperationReporter
  #child: ChildProcess | undefined
  #launch: LauncherHarnessState['launch'] = { kind: 'stopped' }
  /** Buffers launch-child output and reads the announced URL from complete lines. */
  readonly #childOutput = new ChildOutputObserver({
    onText: (stream, text) => {
      // Written before the in-memory cap applies, so the file keeps what the
      // console view discards.
      this.#appendLog(text)
      this.#appendConsoleEntry(classifyChildConsoleStream(stream, text), text)
    },
    onAnnouncedUrl: (url) => this.#announceRunning(url)
  })
  /** Bounded activity feed: Launcher operations, their child output, and the DSH Web launch. */
  #console: LauncherHarnessConsoleEntry[] = []
  /** Monotonic console sequence; append events and snapshots are unioned by it. */
  #consoleSeq = 0
  /** Timestamp of the newest console entry; heartbeat steps read it to stay quiet. */
  #lastConsoleAppendAt = 0
  /** Listeners notified once per appended entry; Electron IPC wiring is the only subscriber. */
  readonly #consoleListeners = new Set<(entry: LauncherHarnessConsoleEntry) => void>()
  #logStream: WriteStream | undefined
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
   * Starts `pnpm dsh -- web --no-open` from the bundled Harness checkout,
   * adding `--port` only for an explicit fixed selection.
   */
  async start(): Promise<LauncherHarnessState> {
    // The slot is claimed before the first await: readiness checks are async, so
    // two quick activations would both pass a check placed after them and spawn
    // two children on the same port.
    if (this.#launch.kind === 'running' || this.#launch.kind === 'starting') {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'DSH Web is already running.'
      )
    }
    this.#launch = { kind: 'starting' }
    this.#childOutput.reset()
    await this.#openLogStream()
    // The console is deliberately not cleared here: the install, update, or
    // switch that prepared this launch is the context a failed launch needs,
    // and a running DSH Web is never a reason to erase what came before it.
    this.#appendLauncherEvent('--- New DSH Web launch ---')
    this.#appendLauncherEvent('Checking the selected Harness checkout and launch settings.')
    try {
      await this.#loadPort()
      const active = await this.#requireActiveVersion()
      const readiness = await readHarnessReadiness(active.directory)
      if (readiness.kind !== 'ready') {
        throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
      }
    } catch (error) {
      // A failed precondition must release the slot it just claimed.
      this.#appendLauncherEvent(
        `Launch preflight failed: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      this.#closeLogStream()
      this.#launch = { kind: 'stopped' }
      throw error
    }
    let child: ChildProcess
    try {
      const active = await this.#requireActiveVersion()
      const launch = resolvePnpmCommand(this.#options.pnpmExecutable, this.#options.pnpmLauncher, [
        ...launcherWebStartArguments(this.#options.diagnosticsPatchPath, this.#port)
      ])
      child = spawn(launch.executable, launch.arguments, {
        cwd: active.directory,
        env: pnpmCommandEnvironment(this.#options.pnpmLauncher),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.#appendLauncherEvent(
        `DSH Web process could not be created: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      this.#closeLogStream()
      this.#launch = {
        kind: 'failed',
        message: error instanceof Error ? error.message : 'DSH Web could not start.'
      }
      throw new ManagedHarnessRuntimeError(
        'runtime.spawn_failed',
        'DSH Web process could not be created.'
      )
    }
    this.#child = child
    if (child.pid === undefined) {
      this.#appendLauncherEvent('DSH Web child creation is pending its spawn result.')
    } else {
      this.#appendLauncherEvent(
        `Started DSH Web child (pid=${String(child.pid)}); waiting for its URL announcement.`
      )
    }
    this.#launch = { kind: 'starting' }
    this.#childOutput.attach(child)
    child.once('error', (error) => {
      this.#appendLauncherEvent(`DSH Web child error: ${error.message}`)
      this.#launch = { kind: 'failed', message: error.message }
    })
    child.once('exit', (code, signal) => {
      // The exit reason is the single most useful line when a launch fails, and
      // it is not part of the child's own output, so the log records it too.
      this.#appendLauncherEvent(
        `DSH Web process exited (code=${String(code ?? 'none')} signal=${String(signal ?? 'none')}).`
      )
      this.#closeLogStream()
      this.#child = undefined
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
        this.#launch = { kind: 'stopped' }
        return
      }
      this.#launch = { kind: 'failed', message: 'DSH Web exited unexpectedly.' }
    })
    return this.getState()
  }
  /**
   * Records the port the next launch will request.
   *
   * A running child keeps its current port: the setting takes effect on the
   * next start, because `dsh web` binds its port at startup.
   */
  async setPort(port: LauncherHarnessPortSetting): Promise<LauncherHarnessState> {
    await this.#loadPort()
    this.#port = assertPortSetting(port)
    await mkdir(nodePath.dirname(this.#options.launchPreferencesPath), { recursive: true })
    await writeFile(
      this.#options.launchPreferencesPath,
      `${JSON.stringify({ format: LAUNCH_PREFERENCES_FORMAT, port: this.#port }, undefined, 2)}\n`,
      'utf8'
    )
    return this.getState()
  }
  /** Reads the persisted port exactly once; an unreadable file keeps the automatic default. */
  async #loadPort(): Promise<void> {
    if (this.#portLoaded) return
    this.#portLoaded = true
    let text: string
    try {
      text = await readFile(this.#options.launchPreferencesPath, 'utf8')
    } catch {
      return
    }
    this.#port = parseLaunchPreferencesPort(text)
  }
  /**
   * Starts a fresh log for each launch, so the file always describes the run the
   * user is looking at rather than an accumulation of every past attempt.
   */
  async #openLogStream(): Promise<void> {
    this.#closeLogStream()
    await mkdir(nodePath.dirname(this.#options.launchLogPath), { recursive: true })
    const stream = createWriteStream(this.#options.launchLogPath, { flags: 'w' })
    // An unwritable log must not take down the launch it was meant to explain.
    stream.on('error', () => {
      this.#logStream = undefined
    })
    this.#logStream = stream
    this.#appendLog(`[launcher] ${new Date().toISOString()} starting dsh web\n`)
  }

  #closeLogStream(): void {
    this.#logStream?.end()
    this.#logStream = undefined
  }

  #appendLog(text: string): void {
    this.#logStream?.write(text)
  }
  /** Records one lifecycle event generated by the Launcher rather than the child process. */
  #appendLauncherEvent(message: string): void {
    const text = formatLauncherLifecycleEvent(message)
    this.#appendLog(text)
    this.#appendConsoleEntry('launcher', text)
  }
  /** Mirrors one operation child's output fragment into the log and live console. */
  #appendProcessOutput(stream: 'stdout' | 'stderr', text: string): void {
    if (text.length === 0) return
    this.#appendLog(text)
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
  /**
   * Promotes `starting` to `running` only when the child announces its own URL.
   * The Launcher cannot infer this address: the port is chosen by DSH and the
   * announced URL may carry a session credential.
   */
  #announceRunning(url: string): void {
    if (this.#launch.kind !== 'starting') return
    this.#launch = { kind: 'running', url }
    this.#appendLauncherEvent('DSH Web announced its loopback URL; runtime is ready.')
  }
  /** Stops the exact DSH process tree this service created. */
  async stop(): Promise<LauncherHarnessState> {
    if (
      this.#child === undefined ||
      (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting')
    ) {
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'DSH Web is not running.')
    }
    this.#appendLauncherEvent('Stopping the managed DSH Web process tree.')
    await terminateManagedChild(this.#child)
    this.#launch = { kind: 'stopped' }
    return this.getState()
  }
  /** Stops the active DSH tree before Electron relinquishes main-process ownership. */
  async shutdown(): Promise<void> {
    if (this.#child === undefined) return
    if (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting') return
    this.#appendLauncherEvent('Launcher is shutting down the managed DSH Web process tree.')
    await terminateManagedChild(this.#child)
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
