import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { assertRegisteredNodeExecutable, type NodeExecutableRegistration } from './toolchain'
import { ManagedHarnessRuntimeError, type ManagedHarnessRuntimeErrorCode } from './runtime-errors'

/** State of one standard DSH Web process managed by the Launcher. */
export type ManagedHarnessRuntimeState = 'running' | 'stopped' | 'failed'

/** Bounded observable process facts retained by the Launcher. */
export interface ManagedHarnessRuntimeDiagnostics {
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly receivedFrameCount: number
  readonly lastFrameType: string | undefined
  readonly exitCode: number | undefined
  readonly exitSignal: string | undefined
}

/** Renderer-safe status for one managed standard DSH process. */
export interface ManagedHarnessLaunchView {
  readonly installationId: string
  readonly launchId: string
  readonly state: ManagedHarnessRuntimeState
  readonly worktreePath: string
  readonly revision: string
  readonly descriptorPath: undefined
  readonly descriptorIdentity: undefined
  readonly failure: Readonly<{ code: ManagedHarnessRuntimeErrorCode; message: string }> | undefined
  readonly diagnostics: ManagedHarnessRuntimeDiagnostics
}

/** Inputs required to start existing DSH without rewriting its configuration or environment. */
export interface ManagedHarnessWebRuntimeStartInput {
  readonly installationId: string
  readonly launchId: string
  readonly node: NodeExecutableRegistration
  readonly worktreePath: string
  readonly revision: string
}

/** Process spawner retained as a narrow test seam. */
export type ManagedHarnessWebSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess

interface RuntimeRecord {
  readonly input: ManagedHarnessWebRuntimeStartInput
  readonly child: ChildProcess
  state: ManagedHarnessRuntimeState
  failure: ManagedHarnessLaunchView['failure']
  diagnostics: MutableDiagnostics
}

interface MutableDiagnostics extends ManagedHarnessRuntimeDiagnostics {
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | undefined
  exitSignal: string | undefined
}

const MAXIMUM_OUTPUT_BYTES = 64 * 1024

/** Starts the ordinary built DSH Web profile without supplying DSH_HOME or private descriptor state. */
export class ManagedHarnessWebRuntimeSupervisor {
  readonly #records = new Map<string, RuntimeRecord>()
  readonly #spawnProcess: ManagedHarnessWebSpawner
  readonly #inheritedEnvironment: () => NodeJS.ProcessEnv

  constructor(
    options: {
      readonly spawnProcess?: ManagedHarnessWebSpawner
      readonly inheritedEnvironment?: () => NodeJS.ProcessEnv
    } = {}
  ) {
    this.#spawnProcess = options.spawnProcess ?? spawn
    this.#inheritedEnvironment = options.inheritedEnvironment ?? (() => process.env)
  }

  /** Starts the worktree's standard `dsh web --no-open` command. */
  async start(input: ManagedHarnessWebRuntimeStartInput): Promise<ManagedHarnessLaunchView> {
    assertStartInput(input)
    const existing = this.#records.get(input.installationId)
    if (existing?.state === 'running') {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'Managed Harness is already running.'
      )
    }
    await assertRegisteredNodeExecutable(input.node)
    await assertBuiltDshEntry(input.worktreePath)
    let child: ChildProcess
    try {
      child = this.#spawnProcess(
        input.node.canonicalPath,
        ['apps/cli/lib/bin.js', 'web', '--no-open'],
        {
          cwd: input.worktreePath,
          env: { ...this.#inheritedEnvironment() },
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    } catch (error) {
      throw new ManagedHarnessRuntimeError(
        'runtime.spawn_failed',
        'Managed DSH process could not be created.',
        {
          cause: error instanceof Error ? error.name : 'unknown'
        }
      )
    }
    const record: RuntimeRecord = {
      input,
      child,
      state: 'running',
      failure: undefined,
      diagnostics: {
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        receivedFrameCount: 0,
        lastFrameType: undefined,
        exitCode: undefined,
        exitSignal: undefined
      }
    }
    this.#records.set(input.installationId, record)
    child.stdout?.on('data', (chunk: unknown) => appendOutput(record.diagnostics, 'stdout', chunk))
    child.stderr?.on('data', (chunk: unknown) => appendOutput(record.diagnostics, 'stderr', chunk))
    child.on('error', (error) => {
      record.state = 'failed'
      record.failure = { code: 'runtime.child_crashed', message: error.message }
    })
    child.on('exit', (code, signal) => {
      record.diagnostics.exitCode = code ?? undefined
      record.diagnostics.exitSignal = signal ?? undefined
      if (record.state === 'failed') return
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
        record.state = 'stopped'
        return
      }
      record.state = 'failed'
      record.failure = {
        code: 'runtime.child_crashed',
        message: 'Managed DSH Web process exited unexpectedly.'
      }
    })
    return this.#view(record)
  }

  /** Stops exactly one active DSH process without modifying its DSH configuration. */
  async stop(installationId: string): Promise<ManagedHarnessLaunchView> {
    const record = this.#records.get(installationId)
    if (record === undefined)
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'Managed Harness is not running.')
    if (record.state === 'running' && !record.child.kill('SIGTERM')) {
      throw new ManagedHarnessRuntimeError(
        'runtime.child_unavailable',
        'Managed DSH process could not be stopped.'
      )
    }
    if (record.state === 'running') record.state = 'stopped'
    return this.#view(record)
  }

  /** Returns one Launcher-owned process record. */
  launchFor(installationId: string): ManagedHarnessLaunchView {
    const record = this.#records.get(installationId)
    if (record === undefined)
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'Managed Harness is not running.')
    return this.#view(record)
  }

  #view(record: RuntimeRecord): ManagedHarnessLaunchView {
    return {
      installationId: record.input.installationId,
      launchId: record.input.launchId,
      state: record.state,
      worktreePath: record.input.worktreePath,
      revision: record.input.revision,
      descriptorPath: undefined,
      descriptorIdentity: undefined,
      failure: record.failure,
      diagnostics: { ...record.diagnostics }
    }
  }
}

function assertStartInput(input: ManagedHarnessWebRuntimeStartInput): void {
  if (
    !input ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.installationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.launchId) ||
    !/^[0-9a-f]{40}$/u.test(input.revision) ||
    !nodePath.isAbsolute(input.worktreePath) ||
    nodePath.normalize(input.worktreePath) !== input.worktreePath
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'Managed DSH launch input is invalid.'
    )
  }
}

async function assertBuiltDshEntry(worktreePath: string): Promise<void> {
  const entry = nodePath.join(worktreePath, 'apps', 'cli', 'lib', 'bin.js')
  const metadata = await lstat(entry)
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(entry)) !== entry) {
    throw new ManagedHarnessRuntimeError(
      'runtime.worktree_invalid',
      'Managed Harness has no direct built dsh entry.'
    )
  }
}

function appendOutput(
  diagnostics: MutableDiagnostics,
  stream: 'stdout' | 'stderr',
  chunk: unknown
): void {
  const key = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'
  const truncatedKey = stream === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated'
  diagnostics[key] += Buffer.byteLength(typeof chunk === 'string' ? chunk : String(chunk))
  if (diagnostics[key] > MAXIMUM_OUTPUT_BYTES) diagnostics[truncatedKey] = true
}
