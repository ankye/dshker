import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import type {
  LauncherHarnessCommitView,
  LauncherHarnessConsoleEntry,
  LauncherHarnessPluginView,
  LauncherHarnessState,
  LauncherHarnessVersionView
} from '../../../src/shared/contracts'
import { ManagedHarnessRuntimeError } from './runtime-errors'

/** Inputs for the single Launcher-owned Harness checkout. */
export interface LauncherHarnessServiceOptions {
  readonly harnessDirectory: string
  readonly dshHomeDirectory: string
  readonly gitExecutable: string
  readonly pnpmExecutable: string
  /**
   * Optional direct pnpm launch command for platforms whose registered pnpm is
   * a shell shim. Windows pnpm is a `.CMD` wrapper, so the launcher runs the
   * underlying Node script through `node` instead of spawning the shim.
   */
  readonly pnpmLauncher?: Readonly<{
    readonly executable: string
    readonly prefixArguments: readonly string[]
  }>
}

/** Starts the packaged checkout without changing its native DSH configuration. */
export class LauncherHarnessService {
  readonly #options: LauncherHarnessServiceOptions
  #child: ChildProcess | undefined
  #launch: LauncherHarnessState['launch'] = { kind: 'stopped' }
  #console: LauncherHarnessConsoleEntry[] = []
  #bootstrap: 'preparing' | { readonly kind: 'failed'; readonly message: string } | undefined

  constructor(options: LauncherHarnessServiceOptions) {
    this.#options = options
  }

  /** Records package initialization progress without changing the Harness checkout. */
  setBootstrapState(
    state: 'preparing' | { readonly kind: 'failed'; readonly message: string } | undefined
  ): void {
    this.#bootstrap = state
  }

  /** Returns only facts read from the Launcher checkout and the native DSH web profile. */
  async getState(): Promise<LauncherHarnessState> {
    if (this.#bootstrap === 'preparing') {
      return {
        kind: 'preparing',
        harnessDirectory: this.#options.harnessDirectory,
        message: 'The bundled DSH is being prepared.',
        launch: this.#launch,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console
      }
    }
    if (this.#bootstrap?.kind === 'failed') {
      return {
        kind: 'invalid',
        harnessDirectory: this.#options.harnessDirectory,
        message: this.#bootstrap.message,
        launch: this.#launch,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console
      }
    }
    const readiness = await this.#readiness()
    if (readiness.kind !== 'ready') {
      return {
        ...readiness,
        launch: this.#launch,
        commits: [],
        stableVersions: [],
        plugins: [],
        console: this.#console
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
      commits,
      stableVersions,
      plugins,
      console: this.#console
    }
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

  /** Installs one curated plugin source into the native web profile via the DSH CLI. */
  async installPlugin(source: string): Promise<LauncherHarnessState> {
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/u.test(source)) {
      throw new ManagedHarnessRuntimeError(
        'runtime.input_invalid',
        'A GitHub HTTPS plugin source is required.'
      )
    }
    await this.#assertReadyForVersionOperation()
    await this.#runPnpm(['dsh', '--', 'plugin', '--profile', 'web', 'add', source])
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
    await this.#runPnpm(['dsh', '--', 'plugin', '--profile', 'web', 'remove', name])
    return this.getState()
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
    await runText(this.#options.gitExecutable, [
      '-C',
      this.#options.harnessDirectory,
      'checkout',
      '--detach',
      commit
    ])
    await this.#runPnpm(['install', '--frozen-lockfile'])
    await this.#runPnpm(['run', 'build'])
    return this.getState()
  }

  /** Runs one pnpm command inside the Launcher-owned Harness checkout. */
  async #runPnpm(arguments_: readonly string[]): Promise<void> {
    const launch = this.#pnpmLaunch(arguments_)
    await runText(launch.executable, launch.arguments, {
      cwd: this.#options.harnessDirectory
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

  /** Starts exactly `pnpm dsh -- web --no-open` from the bundled Harness checkout. */
  async start(): Promise<LauncherHarnessState> {
    const readiness = await this.#readiness()
    if (readiness.kind !== 'ready') {
      throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
    }
    if (this.#launch.kind === 'running' || this.#launch.kind === 'starting') {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'DSH Web is already running.'
      )
    }
    this.#launch = { kind: 'starting' }
    let child: ChildProcess
    try {
      const launch = this.#pnpmLaunch(['dsh', '--', 'web', '--no-open'])
      child = spawn(launch.executable, launch.arguments, {
        cwd: this.#options.harnessDirectory,
        env: { ...process.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
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
    this.#console = []
    this.#launch = { kind: 'starting' }
    child.stdout?.on('data', (chunk: unknown) => this.#appendConsole('stdout', chunk))
    child.stderr?.on('data', (chunk: unknown) => this.#appendConsole('stderr', chunk))
    child.once('error', (error) => {
      this.#launch = { kind: 'failed', message: error.message }
    })
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
        this.#launch = { kind: 'stopped' }
        return
      }
      this.#launch = { kind: 'failed', message: 'DSH Web exited unexpectedly.' }
    })
    return this.getState()
  }

  #appendConsole(stream: LauncherHarnessConsoleEntry['stream'], chunk: unknown): void {
    const text = String(chunk)
    if (text.length === 0) return
    this.#console.push({ stream, occurredAt: Date.now(), text })
    if (this.#console.length > 1_000) this.#console.splice(0, this.#console.length - 1_000)
    this.#observeAnnouncedUrl(text)
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
  }

  /** Stops only the process this service created. */
  async stop(): Promise<LauncherHarnessState> {
    if (
      this.#child === undefined ||
      (this.#launch.kind !== 'running' && this.#launch.kind !== 'starting')
    ) {
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'DSH Web is not running.')
    }
    if (!this.#child.kill('SIGTERM')) {
      throw new ManagedHarnessRuntimeError(
        'runtime.child_unavailable',
        'DSH Web process could not be stopped.'
      )
    }
    this.#launch = { kind: 'stopped' }
    return this.getState()
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
        'runtime.operation_in_progress',
        'Stop DSH Web before changing its version.'
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
    return parseProfilePluginRecords(JSON.parse(content))
  }
}

/**
 * Derives the plugin-layer view from one parsed DSH `web` profile manifest.
 *
 * `dsh.profile.bundles` names every active layer; template bundles that are
 * not dependencies are in-box defaults, while every dependency is a
 * user-installed plugin. A name that is both stays one user entry.
 */
export function parseProfilePluginRecords(value: unknown): readonly LauncherHarnessPluginView[] {
  if (!isRecord(value)) throw new Error('The native DSH web profile package record is invalid.')
  const dependencies = value.dependencies ?? {}
  if (!isRecord(dependencies)) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  const bundles = readProfileBundles(value.dsh)
  const views = new Map<string, LauncherHarnessPluginView>()
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== 'string') {
      throw new Error('The native DSH web profile package record is invalid.')
    }
    views.set(name, { name, version, origin: 'user' })
  }
  for (const name of bundles) {
    if (views.has(name)) continue
    views.set(name, { name, version: '', origin: 'default' })
  }
  return [...views.values()].sort(
    (left, right) =>
      Number(left.origin === 'default') - Number(right.origin === 'default') ||
      left.name.localeCompare(right.name)
  )
}

function readProfileBundles(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!isRecord(value) || !isRecord(value.profile)) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  const bundles = value.profile.bundles
  if (bundles === undefined) return []
  if (!Array.isArray(bundles) || bundles.some((entry) => typeof entry !== 'string')) {
    throw new Error('The native DSH web profile package record is invalid.')
  }
  return bundles
}

/** Loopback host DSH uses for its own announced Web URL. */
const ANNOUNCED_URL_LINE = /^dsh web:\s*(\S+)/mu

/**
 * Reads the exact URL from DSH's own `dsh web: <url>` startup line.
 *
 * Only a loopback http(s) origin is accepted, so a log line quoting some other
 * address can never redirect the Launcher's runtime view. The query and fragment
 * are preserved because DSH may place a session credential there.
 */
export function parseAnnouncedWebUrl(text: string): string | undefined {
  const matched = ANNOUNCED_URL_LINE.exec(text)
  if (matched === null) return undefined
  const candidate = matched[1]
  if (candidate === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '[::1]'
  ) {
    return undefined
  }
  return parsed.toString()
}

async function assertDirectDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error('A direct directory is required.')
  }
}

async function assertDirectRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(filePath)) !== filePath) {
    throw new Error('A direct regular file is required.')
  }
}

function runText(
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, arguments_, {
        ...options,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.slice(-4096)))
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
