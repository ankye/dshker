import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import {
  assertRegisteredNodeExecutable,
  assertRegisteredPnpmExecutable,
  preflightCheckoutToolchain,
  readCheckoutToolchainRequirements,
  type NodeExecutableRegistration,
  type PnpmExecutableRegistration
} from './toolchain'

const PREPARE_TIMEOUT_MILLISECONDS = 10 * 60 * 1_000
const PREPARE_MAX_OUTPUT_BYTES = 1_048_576

/** Direct spawn seam for deterministic source-worktree preparation tests. */
export type ManagedWorktreeProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess

/** Exact facts required to prepare one selected managed checkout for source-profile launch. */
export interface ManagedWorktreePreparationRequest {
  readonly worktreePath: string
  readonly node: NodeExecutableRegistration
  readonly pnpm: PnpmExecutableRegistration
}

/** Installs the selected lockfile with the selected toolchain and proves the source CLI launcher is present. */
export class ManagedHarnessWorktreePreparer {
  readonly #spawnProcess: ManagedWorktreeProcessSpawner

  constructor(spawnProcess: ManagedWorktreeProcessSpawner = directSpawn) {
    this.#spawnProcess = spawnProcess
  }

  /** Performs no inferred package-manager lookup; the persisted toolchain is the only launcher. */
  async prepare(request: ManagedWorktreePreparationRequest): Promise<void> {
    await assertCanonicalWorktree(request.worktreePath)
    const requirements = await readCheckoutToolchainRequirements(request.worktreePath)
    await preflightCheckoutToolchain(requirements, request.node, request.pnpm)
    await runPnpmCommand(this.#spawnProcess, request, [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts'
    ])
    await assertRegisteredNodeExecutable(request.node)
    await assertRegisteredPnpmExecutable(request.pnpm)
    await assertSourceLauncher(request.worktreePath)
  }
}

async function assertCanonicalWorktree(worktreePath: string): Promise<void> {
  if (
    typeof worktreePath !== 'string' ||
    worktreePath.length === 0 ||
    worktreePath.includes('\u0000') ||
    !nodePath.isAbsolute(worktreePath) ||
    nodePath.normalize(worktreePath) !== worktreePath ||
    nodePath.parse(worktreePath).root === worktreePath
  ) {
    throw new ManagedRootError(
      'managed.toolchain_invalid',
      'Managed Harness worktree path is invalid.'
    )
  }
  try {
    const metadata = await lstat(worktreePath)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ManagedRootError(
        'managed.toolchain_invalid',
        'Managed Harness worktree must be a direct directory.'
      )
    }
    if ((await realpath(worktreePath)) !== worktreePath) {
      throw new ManagedRootError(
        'managed.toolchain_invalid',
        'Managed Harness worktree changed while being prepared.'
      )
    }
  } catch (error) {
    if (error instanceof ManagedRootError) throw error
    throw new ManagedRootError(
      'managed.toolchain_invalid',
      'Managed Harness worktree is unavailable.',
      {
        cause: error instanceof Error ? error.name : 'unknown'
      }
    )
  }
}

async function assertSourceLauncher(worktreePath: string): Promise<void> {
  const sourceLauncher = nodePath.join(worktreePath, 'apps', 'cli', 'src', 'bin.ts')
  const tsxPackage = nodePath.join(worktreePath, 'node_modules', 'tsx', 'package.json')
  await Promise.all([
    assertRegularFile(sourceLauncher, 'Managed Harness source launcher'),
    assertResolvableRegularFile(tsxPackage, 'Managed Harness tsx package')
  ])
}

async function assertRegularFile(path: string, subject: string): Promise<void> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ManagedRootError('managed.toolchain_invalid', `${subject} is unavailable.`)
    }
  } catch (error) {
    if (error instanceof ManagedRootError) throw error
    throw new ManagedRootError('managed.toolchain_invalid', `${subject} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
}

async function assertResolvableRegularFile(path: string, subject: string): Promise<void> {
  try {
    const resolved = await realpath(path)
    const metadata = await lstat(resolved)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ManagedRootError('managed.toolchain_invalid', `${subject} is unavailable.`)
    }
  } catch (error) {
    if (error instanceof ManagedRootError) throw error
    throw new ManagedRootError('managed.toolchain_invalid', `${subject} is unavailable.`, {
      cause: error instanceof Error ? error.name : 'unknown'
    })
  }
}

async function runPnpmCommand(
  spawnProcess: ManagedWorktreeProcessSpawner,
  request: ManagedWorktreePreparationRequest,
  arguments_: readonly string[]
): Promise<void> {
  const launch = pnpmLaunch(request.pnpm, arguments_)
  const environment = { ...process.env }
  delete environment.DSH_DESKTOP_DESCRIPTOR
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(launch.executable, launch.arguments, {
        cwd: request.worktreePath,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(preparationFailure('Managed package installation could not start.', error))
      return
    }
    let observedBytes = 0
    let finished = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: ManagedRootError): void => {
      if (finished) return
      finished = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }
    const inspectOutput = (chunk: unknown): void => {
      const bytes = Buffer.byteLength(String(chunk), 'utf8')
      observedBytes += bytes
      if (observedBytes > PREPARE_MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        finish(
          new ManagedRootError(
            'managed.toolchain_invalid',
            'Managed package installation exceeded the output limit.'
          )
        )
      }
    }
    child.stdout?.on('data', inspectOutput)
    child.stderr?.on('data', inspectOutput)
    child.once('error', (error) => {
      finish(preparationFailure('Managed package installation failed to run.', error))
    })
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        finish()
        return
      }
      finish(
        new ManagedRootError('managed.toolchain_invalid', 'Managed package installation failed.', {
          exitCode: code ?? -1,
          signal: signal ?? 'none'
        })
      )
    })
    timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finish(
        new ManagedRootError('managed.toolchain_invalid', 'Managed package installation timed out.')
      )
    }, PREPARE_TIMEOUT_MILLISECONDS)
  })
}

function pnpmLaunch(
  registration: PnpmExecutableRegistration,
  arguments_: readonly string[]
): Readonly<{ executable: string; arguments: readonly string[] }> {
  if (registration.launcher.kind === 'native') {
    return { executable: registration.canonicalPath, arguments: arguments_ }
  }
  return {
    executable: registration.launcher.node.canonicalPath,
    arguments: [registration.canonicalPath, ...arguments_]
  }
}

function preparationFailure(message: string, cause: unknown): ManagedRootError {
  return new ManagedRootError('managed.toolchain_invalid', message, {
    cause: cause instanceof Error ? cause.name : 'unknown'
  })
}

function directSpawn(
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
): ChildProcess {
  return spawn(executable, arguments_, options)
}
