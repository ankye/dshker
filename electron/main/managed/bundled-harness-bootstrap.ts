import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, mkdtemp, readdir, realpath, rename, rmdir } from 'node:fs/promises'
import nodePath from 'node:path'

/** Explicit package inputs used only to create the first Launcher-owned Harness checkout. */
export interface BundledHarnessBootstrapOptions {
  readonly harnessDirectory: string
  readonly bundlePath: string
  readonly remoteUrl: string
  readonly gitExecutable: string
  readonly pnpmExecutable: string
  /**
   * Optional direct pnpm launch command for platforms whose registered pnpm is
   * a shell shim (Windows `.CMD` wrapper), run through `node` instead.
   */
  readonly pnpmLauncher?: Readonly<{
    readonly executable: string
    readonly prefixArguments: readonly string[]
    /** PATH required by pnpm's shell entrypoint and its subprocesses. */
    readonly commandSearchPath: string
  }>
  /**
   * Receives one line per preparation step, so the Launcher console can show
   * first-run install progress instead of an empty output area.
   */
  readonly onActivity?: (message: string) => void
}

/** Direct child-process seam for package bootstrap tests. */
export type BundledHarnessBootstrapSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess

/**
 * Materializes the packaged Git history exactly once into an empty Harness root.
 *
 * The operation never reads or changes DSH_HOME. A non-empty Harness root is an
 * explicit user or prior-launcher state and is left unchanged.
 */
export class BundledHarnessBootstrap {
  readonly #spawnProcess: BundledHarnessBootstrapSpawner

  constructor(spawnProcess: BundledHarnessBootstrapSpawner = spawn) {
    this.#spawnProcess = spawnProcess
  }

  /** Returns whether this call created the bundled DSH repository. */
  async initialize(options: BundledHarnessBootstrapOptions): Promise<boolean> {
    await assertEmptyDirectDirectory(options.harnessDirectory)
    const entries = await readdir(options.harnessDirectory)
    if (entries.length > 0) return false

    await assertDirectRegularFile(options.bundlePath)
    const parent = nodePath.dirname(options.harnessDirectory)
    const stagingRoot = await mkdtemp(nodePath.join(parent, '.dsh-launcher-seed-'))
    const checkout = nodePath.join(stagingRoot, 'harness')
    try {
      options.onActivity?.('Importing the bundled DSH Git history.')
      await runProcess(this.#spawnProcess, options.gitExecutable, [
        'clone',
        '--branch',
        'master',
        '--single-branch',
        options.bundlePath,
        checkout
      ])
      options.onActivity?.('Pointing the repository at the official DSH remote.')
      await runProcess(this.#spawnProcess, options.gitExecutable, [
        '-C',
        checkout,
        'remote',
        'set-url',
        'origin',
        options.remoteUrl
      ])
      // Dependencies and build artifacts live in per-version directories; the
      // repository published here is history only, so nothing is installed or
      // built at seed time.
      await rmdir(options.harnessDirectory)
      await rename(checkout, options.harnessDirectory)
      return true
    } finally {
      await rmdir(stagingRoot).catch(() => undefined)
    }
  }
}

async function assertEmptyDirectDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error('Bundled Harness destination must be a direct empty directory.')
  }
}

async function assertDirectRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(filePath)) !== filePath) {
    throw new Error('Bundled Harness Git bundle is unavailable.')
  }
}

function runProcess(
  spawnProcess: BundledHarnessBootstrapSpawner,
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(executable, arguments_, {
        ...options,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }
    let output = ''
    const collect = (chunk: unknown): void => {
      if (output.length < 4096) output += String(chunk)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
        return
      }
      reject(new Error(`Bundled Harness bootstrap failed: ${output.slice(-4096)}`))
    })
  })
}
