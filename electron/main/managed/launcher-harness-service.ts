import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import {
  type LauncherHarnessCommitView,
  type LauncherHarnessConsoleEntry,
  type LauncherHarnessLogFileView,
  type LauncherHarnessPluginView,
  type LauncherHarnessPortSetting,
  type LauncherHarnessState,
  type LauncherHarnessVersionView
} from '../../../src/shared/contracts'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import {
  cleanLauncherHarnessCheckout,
  launcherProfilePluginArguments
} from './launcher-harness-commands'
import { terminateManagedProcessTree } from './process-tree'
import { assertDirectDirectory, assertDirectRegularFile, runText } from './process-utils'
import { localGitHubPluginSource } from './legacy-plugin-source'
import { parseAnnouncedWebUrl } from './announced-web-url'
import { waitForChildExit } from './child-exit'
import { ManagedPluginSources, type ManagedPluginInstallSource } from './managed-plugin-sources'
import {
  assertPortSetting,
  LAUNCH_PREFERENCES_FORMAT,
  parseLaunchPreferencesPort
} from './launch-preferences'
import {
  gitUrlOf,
  localPathOf,
  normalizeGitRemote,
  parseProfilePluginRecords
} from './profile-plugins'

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

/** Inputs for the single Launcher-owned Harness checkout. */
export interface LauncherHarnessServiceOptions {
  readonly harnessDirectory: string
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
  #child: ChildProcess | undefined
  #launch: LauncherHarnessState['launch'] = { kind: 'stopped' }
  #console: LauncherHarnessConsoleEntry[] = []
  /** Trailing partial line of child output, held until its newline arrives. */
  #pendingOutput = ''
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
  }

  /** Records package initialization progress without changing the Harness checkout. */
  setBootstrapState(
    state: 'preparing' | { readonly kind: 'failed'; readonly message: string } | undefined
  ): void {
    this.#bootstrap = state
  }

  /** Returns only facts read from the Launcher checkout and the native DSH web profile. */
  async getState(): Promise<LauncherHarnessState> {
    await this.#loadPort()
    if (this.#bootstrap === 'preparing') {
      return {
        kind: 'preparing',
        harnessDirectory: this.#options.harnessDirectory,
        message: 'The bundled DSH is being prepared.',
        launch: this.#launch,
        port: this.#port,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console,
        logFile: await this.#logFileView()
      }
    }
    if (this.#bootstrap?.kind === 'failed') {
      return {
        kind: 'invalid',
        harnessDirectory: this.#options.harnessDirectory,
        message: this.#bootstrap.message,
        launch: this.#launch,
        port: this.#port,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console,
        logFile: await this.#logFileView()
      }
    }
    const readiness = await this.#readiness()
    if (readiness.kind !== 'ready') {
      return {
        ...readiness,
        launch: this.#launch,
        port: this.#port,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console,
        logFile: await this.#logFileView()
      }
    }
    const [remoteUrl, currentBranch, branches, revision, commits, stableVersions, plugins] =
      await Promise.all([
        runText(this.#options.gitExecutable, [
          '-C',
          this.#options.harnessDirectory,
          'remote',
          'get-url',
          'origin'
        ]).then((value) => value.trim()),
        this.#readCurrentBranch(),
        this.#readBranches(),
        runText(this.#options.gitExecutable, [
          '-C',
          this.#options.harnessDirectory,
          'rev-parse',
          'HEAD'
        ]).then((value) => value.trim()),
        this.#readCommits('origin/master'),
        this.#readStableVersions(),
        this.#readPlugins()
      ])
    return {
      kind: 'ready',
      harnessDirectory: this.#options.harnessDirectory,
      remoteUrl,
      currentBranch,
      branches,
      revision,
      launch: this.#launch,
      port: this.#port,
      commits,
      stableVersions,
      plugins,
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
    await this.#assertReadyCheckout()
    await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'fetch',
      '--prune',
      '--tags',
      'origin'
    ])
    return this.getState()
  }

  /** Switches the Launcher-owned checkout to the newest fetched master commit. */
  async update(): Promise<LauncherHarnessState> {
    await this.refreshVersions()
    const commit = (
      await runText(this.#options.gitExecutable, [
        '-C',
        this.#options.harnessDirectory,
        'rev-parse',
        'origin/master'
      ])
    ).trim()
    return this.switchVersion(commit)
  }

  /** Copies or clones a source under Launcher control, then installs that copy through DSH. */
  async installPlugin(source: ManagedPluginInstallSource): Promise<LauncherHarnessState> {
    await this.#assertReadyForVersionOperation()
    const before = await this.#readPlugins()
    const materialized = await this.#pluginSources.materialize(source)
    let pluginCommandSucceeded = false
    try {
      await this.#runPluginCommand(
        launcherProfilePluginArguments('add', `file:${materialized.installDirectory}`)
      )
      pluginCommandSucceeded = true
      const after = await this.#readPlugins()
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

  /** Extracts one native-selected plugin ZIP into Launcher ownership, then installs it through DSH. */
  async installPluginArchive(archivePath: string): Promise<LauncherHarnessState> {
    return this.installPlugin({ kind: 'archive', path: archivePath })
  }

  /** Fetches managed Git sources to calculate update availability without changing DSH's profile. */
  async refreshPlugins(): Promise<LauncherHarnessState> {
    await this.#pluginSources.refreshGitSourceStatus()
    return this.getState()
  }

  /** Removes exactly one user-installed plugin from the native web profile via the DSH CLI. */
  async uninstallPlugin(name: string): Promise<LauncherHarnessState> {
    if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(name) || name.length === 0) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A valid plugin package name is required.'
      )
    }
    await this.#assertReadyForVersionOperation()
    const plugins = await this.#readPlugins()
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
  }

  /** Updates exactly one Git-managed plugin source, then lets DSH reconcile that package. */
  async updatePlugin(name: string): Promise<LauncherHarnessState> {
    if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/u.test(name) || name.length === 0) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A valid plugin package name is required.'
      )
    }
    await this.#assertReadyForVersionOperation()
    const plugins = await this.#readPlugins()
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
  }

  /**
   * Moves one legacy local Git plugin into a Launcher-owned clone, then asks
   * DSH to use that clone as its installed source. The native profile remains
   * the only installation authority.
   */
  async adoptPlugin(name: string): Promise<LauncherHarnessState> {
    this.#assertPluginName(name)
    await this.#assertReadyForVersionOperation()
    const plugins = await this.#readPlugins()
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
      const after = await this.#readPlugins()
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

  /**
   * Runs one DSH plugin CLI command, reporting a CLI refusal as a plugin
   * failure rather than a launch failure.
   */
  async #runPluginCommand(arguments_: readonly string[]): Promise<void> {
    try {
      await this.#runPnpm(arguments_, {
        detached: process.platform !== 'win32',
        timeoutMilliseconds: PLUGIN_COMMAND_TIMEOUT_MILLISECONDS,
        onTimeout: (processId) => terminateManagedProcessTree(processId, process.platform)
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

  /** Resolves the direct pnpm command, forwarding shim-prefix arguments when present. */
  #pnpmLaunch(
    arguments_: readonly string[]
  ): Readonly<{ executable: string; arguments: readonly string[] }> {
    const launcher = this.#options.pnpmLauncher
    if (launcher === undefined) {
      return { executable: this.#options.pnpmExecutable, arguments: arguments_ }
    }
    return {
      executable: launcher.executable,
      arguments: [...launcher.prefixArguments, ...arguments_]
    }
  }

  /** Supplies the Launcher-resolved command PATH to every pnpm invocation. */
  #pnpmEnvironment(): NodeJS.ProcessEnv | undefined {
    const commandSearchPath = this.#options.pnpmLauncher?.commandSearchPath
    return commandSearchPath === undefined ? undefined : { ...process.env, PATH: commandSearchPath }
  }

  /** Materializes an explicitly selected commit from origin/master. */
  async switchVersion(commit: string): Promise<LauncherHarnessState> {
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A complete DSH commit SHA is required.'
      )
    }
    await this.#assertReadyForVersionOperation()
    await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'merge-base',
      '--is-ancestor',
      commit,
      'origin/master'
    ])
    await cleanLauncherHarnessCheckout(this.#options.gitExecutable, this.#options.harnessDirectory)
    await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'checkout',
      '--detach',
      commit
    ])
    await this.#runPnpm(['install', '--frozen-lockfile'])
    await this.#runPnpm(['run', 'build'])
    await this.#runPluginCommand(launcherProfilePluginArguments('update'))
    return this.getState()
  }

  /** Runs one pnpm command inside the Launcher-owned Harness checkout. */
  async #runPnpm(
    arguments_: readonly string[],
    execution: Readonly<{
      readonly detached?: boolean
      readonly timeoutMilliseconds?: number
      readonly onTimeout?: (processId: number | undefined) => void
    }> = {}
  ): Promise<void> {
    const launch = this.#pnpmLaunch(arguments_)
    await runText(launch.executable, launch.arguments, {
      cwd: this.#options.harnessDirectory,
      env: this.#pnpmEnvironment(),
      ...execution
    })
  }

  /** Resolves and switches to one branch from the fetched origin branch list. */
  async switchBranch(branch: string): Promise<LauncherHarnessState> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(branch)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A valid DSH branch is required.'
      )
    }
    await this.refreshVersions()
    const branches = await this.#readBranches()
    if (!branches.includes(branch)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'The selected DSH branch is unavailable.'
      )
    }
    const commit = (
      await runText(this.#options.gitExecutable, [
        '-C',
        this.#options.harnessDirectory,
        'rev-parse',
        `origin/${branch}`
      ])
    ).trim()
    return this.switchVersion(commit)
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
    this.#pendingOutput = ''
    this.#console = []
    await this.#openLogStream()
    this.#appendLauncherEvent('Checking the selected Harness checkout and launch settings.')
    try {
      await this.#loadPort()
      const readiness = await this.#readiness()
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
      const launch = this.#pnpmLaunch([
        ...launcherWebStartArguments(this.#options.diagnosticsPatchPath, this.#port)
      ])
      child = spawn(launch.executable, launch.arguments, {
        cwd: this.#options.harnessDirectory,
        env: this.#pnpmEnvironment(),
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
    child.stdout?.on('data', (chunk: unknown) => this.#appendConsole('stdout', chunk))
    child.stderr?.on('data', (chunk: unknown) => this.#appendConsole('stderr', chunk))
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

  /** Keeps the in-memory diagnostics bounded independently of the on-disk log. */
  #appendConsoleEntry(stream: LauncherHarnessConsoleEntry['stream'], text: string): void {
    this.#console.push({ stream, occurredAt: Date.now(), text })
    if (this.#console.length > 1_000) this.#console.splice(0, this.#console.length - 1_000)
  }

  #appendConsole(stream: 'stdout' | 'stderr', chunk: unknown): void {
    const text = String(chunk)
    if (text.length === 0) return
    // Written before the in-memory cap applies, so the file keeps what the
    // console view discards.
    this.#appendLog(text)
    this.#appendConsoleEntry(classifyChildConsoleStream(stream, text), text)
    // Child stdout arrives in arbitrary chunks that can split a line mid-URL, so
    // the announcement is only read from lines known to be complete. Adopting a
    // truncated URL would drop the session credential DSH puts in its query.
    this.#pendingOutput += text
    const lines = this.#pendingOutput.split('\n')
    this.#pendingOutput = lines.pop() ?? ''
    for (const line of lines) this.#observeAnnouncedUrl(line)
  }

  /**
   * Promotes `starting` to `running` only when the child announces its own URL.
   * The Launcher cannot infer this address: the port is chosen by DSH and the
   * announced URL may carry a session credential.
   */
  #observeAnnouncedUrl(text: string): void {
    if (this.#launch.kind !== 'starting') return
    const url = parseAnnouncedWebUrl(text)
    if (url === undefined) return
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
    await this.#terminateChild(this.#child)
    this.#launch = { kind: 'stopped' }
    return this.getState()
  }

  /** Stops the active DSH tree before Electron relinquishes main-process ownership. */
  async shutdown(): Promise<void> {
    if (this.#child === undefined) return
    if (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting') return
    this.#appendLauncherEvent('Launcher is shutting down the managed DSH Web process tree.')
    await this.#terminateChild(this.#child)
  }

  /** Signals the owned pnpm process group and waits for its root child to exit. */
  async #terminateChild(child: ChildProcess): Promise<void> {
    const exited = waitForChildExit(child)
    try {
      terminateManagedProcessTree(child.pid, process.platform)
    } catch (error) {
      throw new ManagedHarnessRuntimeError(
        'runtime.child_unavailable',
        error instanceof Error ? error.message : 'Managed DSH process could not be stopped.'
      )
    }
    try {
      await exited
    } catch (error) {
      throw new ManagedHarnessRuntimeError(
        'runtime.shutdown_timeout',
        error instanceof Error ? error.message : 'Managed DSH process did not exit after SIGTERM.'
      )
    }
  }

  async #readiness(): Promise<
    | { readonly kind: 'ready' }
    | {
        readonly kind: 'missing' | 'invalid'
        readonly harnessDirectory: string
        readonly message: string
      }
  > {
    try {
      await assertDirectDirectory(this.#options.harnessDirectory)
    } catch (error) {
      if (isMissing(error)) {
        return {
          kind: 'missing',
          harnessDirectory: this.#options.harnessDirectory,
          message: 'The Launcher Harness directory has not been initialized.'
        }
      }
      return {
        kind: 'invalid',
        harnessDirectory: this.#options.harnessDirectory,
        message: 'The Launcher Harness directory is not a direct directory.'
      }
    }
    try {
      await Promise.all([
        assertDirectRegularFile(nodePath.join(this.#options.harnessDirectory, 'package.json')),
        assertDirectRegularFile(
          nodePath.join(this.#options.harnessDirectory, 'apps', 'cli', 'lib', 'bin.js')
        ),
        assertDirectDirectory(nodePath.join(this.#options.harnessDirectory, '.git'))
      ])
      return { kind: 'ready' }
    } catch {
      return {
        kind: 'invalid',
        harnessDirectory: this.#options.harnessDirectory,
        message: 'The Launcher Harness directory is missing its built DSH checkout.'
      }
    }
  }

  async #readCommits(reference: string): Promise<readonly LauncherHarnessCommitView[]> {
    const output = await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'log',
      '--max-count=100',
      '--format=%H%x1f%ct%x1f%s',
      reference
    ])
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [hash, committedAt, subject] = line.split('\u001f')
        if (!hash || !committedAt || subject === undefined || !/^[0-9a-f]{40}$/u.test(hash)) {
          throw new Error('The bundled Harness Git history is invalid.')
        }
        const milliseconds = Number(committedAt) * 1000
        if (!Number.isSafeInteger(milliseconds))
          throw new Error('The bundled Harness Git history is invalid.')
        return { hash, subject, committedAt: milliseconds }
      })
  }

  async #readStableVersions(): Promise<readonly LauncherHarnessVersionView[]> {
    const tags = (
      await runText(this.#options.gitExecutable, [
        '-C',
        this.#options.harnessDirectory,
        'tag',
        '--merged',
        'origin/master',
        '--sort=-creatordate'
      ])
    )
      .trim()
      .split('\n')
      .filter((tag) => tag.length > 0)
      .slice(0, 100)
    return Promise.all(
      tags.map(async (tag) => {
        const [commit] = await this.#readCommits(tag)
        if (commit === undefined) throw new Error('The bundled Harness release tag is invalid.')
        return { ...commit, tag }
      })
    )
  }

  async #readCurrentBranch(): Promise<string> {
    const branch = (
      await runText(this.#options.gitExecutable, [
        '-C',
        this.#options.harnessDirectory,
        'branch',
        '--show-current'
      ])
    ).trim()
    return branch.length === 0 ? 'master' : branch
  }

  async #readBranches(): Promise<readonly string[]> {
    const output = await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin'
    ])
    return output
      .trim()
      .split('\n')
      .filter((reference) => reference.startsWith('origin/') && reference !== 'origin/HEAD')
      .map((reference) => reference.slice('origin/'.length))
      .sort((left, right) => left.localeCompare(right))
  }

  async #assertReadyForVersionOperation(): Promise<void> {
    await this.#assertReadyCheckout()
    if (this.#launch.kind === 'running' || this.#launch.kind === 'starting') {
      throw new ManagedHarnessRuntimeError(
        'runtime.busy_running',
        'Stop DSH Web before changing its version or plugins.'
      )
    }
  }

  async #assertReadyCheckout(): Promise<void> {
    const readiness = await this.#readiness()
    if (readiness.kind !== 'ready') {
      throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
    }
  }

  async #readPlugins(): Promise<readonly LauncherHarnessPluginView[]> {
    const packagePath = nodePath.join(
      this.#options.dshHomeDirectory,
      'profiles',
      'web',
      'package.json'
    )
    try {
      await assertDirectRegularFile(packagePath)
    } catch (error) {
      if (isMissing(error)) return []
      throw new Error('The native DSH web profile package record is invalid.')
    }
    const content = await readFile(packagePath, 'utf8')
    const [views, managedGitSources] = await Promise.all([
      Promise.resolve(parseProfilePluginRecords(JSON.parse(content))),
      this.#pluginSources.gitSources()
    ])
    // A `file:` dependency carries no git source in the manifest, so the remote
    // is read from the checkout it points at. Resolution is best-effort: a
    // plugin whose checkout is gone still lists with its name and version.
    return Promise.all(
      views.map(async (view) => {
        const resolved = await this.#withResolvedSource(view)
        const managedGitSource = managedGitSources.get(view.name)
        return managedGitSource === undefined
          ? resolved
          : {
              ...resolved,
              managedGitSource: {
                revision: managedGitSource.revision,
                updateAvailable: managedGitSource.updateAvailable,
                ...(managedGitSource.branch === undefined
                  ? {}
                  : { branch: managedGitSource.branch })
              }
            }
      })
    )
  }

  /** Adds the git remote and local path for a `file:` dependency, when readable. */
  async #withResolvedSource(view: LauncherHarnessPluginView): Promise<LauncherHarnessPluginView> {
    const localPath = localPathOf(view.version)
    if (localPath === undefined) {
      const direct = gitUrlOf(view.version)
      return direct === undefined ? view : { ...view, sourceUrl: direct }
    }
    try {
      const remote = (
        await runText(this.#options.gitExecutable, ['-C', localPath, 'remote', 'get-url', 'origin'])
      ).trim()
      const normalized = normalizeGitRemote(remote)
      return {
        ...view,
        localPath,
        ...(normalized === undefined ? {} : { sourceUrl: normalized })
      }
    } catch {
      return { ...view, localPath }
    }
  }
}

/** Formats one Launcher-owned lifecycle event for both the durable log and live Console view. */
export function formatLauncherLifecycleEvent(message: string): string {
  return `[launcher] ${message}\n`
}

/** Builds the exact DSH command, including Launcher-owned verbose logging for this child. */
export function launcherWebStartArguments(
  diagnosticsPatchPath: string,
  port: LauncherHarnessPortSetting
): readonly string[] {
  return [
    'dsh',
    'web',
    '--patch',
    diagnosticsPatchPath,
    '--no-open',
    ...(port.mode === 'fixed' ? ['--port', String(port.port)] : [])
  ]
}

/** Separates pnpm's one-line script echo from diagnostics written to standard error. */
export function classifyChildConsoleStream(
  stream: 'stdout' | 'stderr',
  text: string
): LauncherHarnessConsoleEntry['stream'] {
  return stream === 'stderr' && /^\$\s+\S[^\r\n]*(?:\r?\n)?$/u.test(text) ? 'command' : stream
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
