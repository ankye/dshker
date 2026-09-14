// The managed installation's DSH Web child.
//
// The shell used to spawn `node apps/cli/lib/bin.js web --no-open` itself, from
// the installation's worktree. The core does now — the same command through its
// named `node` profile, the same worktree, the same bounded diagnostics — so
// this file is the shell's view of that child: the facts the shell owns (which
// installation, which worktree, which revision) joined with the core's answer.
import nodePath from 'node:path'
import type { CoreHarnessLaunchView, CoreHarnessRuntimePort } from '../core/harness-runtime'
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

/** One installation the shell has observed, and what the core last said about it. */
interface RuntimeRecord {
  readonly input: ManagedHarnessWebRuntimeStartInput | undefined
  readonly view: ManagedHarnessLaunchView
}

/** Starts the ordinary built DSH Web profile without supplying DSH_HOME or private descriptor state. */
export class ManagedHarnessWebRuntimeSupervisor {
  readonly #records = new Map<string, RuntimeRecord>()
  readonly #runtime: () => CoreHarnessRuntimePort | undefined

  constructor(options: { readonly runtime?: () => CoreHarnessRuntimePort | undefined } = {}) {
    this.#runtime = options.runtime ?? (() => undefined)
  }

  /** Starts the worktree's standard `dsh web --no-open` command through the core. */
  async start(input: ManagedHarnessWebRuntimeStartInput): Promise<ManagedHarnessLaunchView> {
    assertStartInput(input)
    if (this.#records.get(input.installationId)?.view.state === 'running') {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'Managed Harness is already running.'
      )
    }
    // The registration is the shell's own record of the Node it pinned, and its
    // identity is re-checked here as it always was. The built entry is the
    // core's to verify, because the core is what runs it.
    await assertRegisteredNodeExecutable(input.node)
    const answered = await this.#requireRuntime().start({
      launchId: input.launchId,
      subjectId: input.installationId,
      directory: input.worktreePath,
      profile: 'node',
      nodeExecutable: input.node.canonicalPath,
      pnpmExecutable: '',
      pnpmPrefixArguments: [],
      pnpmResolutionError: '',
      pnpmCommandSearchPath: '',
      diagnosticsPatchPath: '',
      port: { mode: 'auto' },
      logPath: ''
    })
    const view = this.#viewOf(input, answered)
    this.#records.set(input.installationId, { input, view })
    return view
  }

  /** Stops exactly one active DSH process without modifying its DSH configuration. */
  async stop(installationId: string): Promise<ManagedHarnessLaunchView> {
    const answered = await this.#requireRuntime().stop(installationId)
    const existing = this.#records.get(installationId)
    const view = this.#viewOf(existing?.input, answered)
    this.#records.set(installationId, { input: existing?.input, view })
    return view
  }

  /**
   * Reads one installation's launch record from the core.
   *
   * The answer is authoritative rather than cached: a child that exited while no
   * one was looking is a stopped or failed record the moment it is read, which is
   * what the shell's own exit listeners used to decide.
   */
  async launchFor(installationId: string): Promise<ManagedHarnessLaunchView> {
    const answered = await this.#requireRuntime().status(installationId)
    if (answered === undefined) {
      this.#records.delete(installationId)
      throw new ManagedHarnessRuntimeError('runtime.not_found', 'Managed Harness is not running.')
    }
    const existing = this.#records.get(installationId)
    const view = this.#viewOf(existing?.input, answered)
    this.#records.set(installationId, { input: existing?.input, view })
    return view
  }

  #requireRuntime(): CoreHarnessRuntimePort {
    const runtime = this.#runtime()
    if (runtime === undefined) {
      throw new ManagedHarnessRuntimeError(
        'runtime.child_unavailable',
        'The Launcher core is not running, so no managed Harness can be supervised.'
      )
    }
    return runtime
  }

  #viewOf(
    input: ManagedHarnessWebRuntimeStartInput | undefined,
    answered: CoreHarnessLaunchView
  ): ManagedHarnessLaunchView {
    return {
      installationId: input?.installationId ?? answered.subjectId,
      launchId: input?.launchId ?? answered.launchId,
      state: managedStateOf(answered),
      worktreePath: input?.worktreePath ?? answered.directory,
      revision: input?.revision ?? '',
      descriptorPath: undefined,
      descriptorIdentity: undefined,
      failure:
        answered.failure === undefined
          ? undefined
          : {
              code: answered.failure.code as ManagedHarnessRuntimeErrorCode,
              message: answered.failure.message
            },
      diagnostics: diagnosticsOf(answered)
    }
  }
}

/** Projects the core's four launch states onto the three the renderer knows. */
function managedStateOf(answered: CoreHarnessLaunchView): ManagedHarnessRuntimeState {
  if (answered.state === 'stopped') return 'stopped'
  if (answered.state === 'failed') return 'failed'
  return 'running'
}

function diagnosticsOf(answered: CoreHarnessLaunchView): ManagedHarnessRuntimeDiagnostics {
  return {
    stdoutBytes: answered.diagnostics.stdoutBytes,
    stderrBytes: answered.diagnostics.stderrBytes,
    stdoutTruncated: answered.diagnostics.stdoutTruncated,
    stderrTruncated: answered.diagnostics.stderrTruncated,
    // These counters belonged to the descriptor handshake this profile never
    // used; they stay at the values a fresh launch reports.
    receivedFrameCount: 0,
    lastFrameType: undefined,
    exitCode: answered.diagnostics.exitCode,
    exitSignal: answered.diagnostics.exitSignal
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
