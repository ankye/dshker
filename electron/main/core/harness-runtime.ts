// The main-only view of the core's DSH Web child.
//
// The shell used to build and supervise that process itself. The core does now —
// same command, same port rule, same log — so this file is the only way the shell
// reaches it. Only Electron main holds one of these, and no path or identifier
// ever reaches the renderer through it.
import type { LauncherHarnessPortSetting } from '../../../src/shared/contracts'
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** Launch states the core reports, which are the shell's own four. */
export type CoreHarnessState = 'starting' | 'running' | 'stopped' | 'failed'

/** Bounded observable facts about one launch child. */
export interface CoreHarnessDiagnostics {
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly exitCode?: number
  readonly exitSignal?: string
}

/** One launch record as the core answers it. */
export interface CoreHarnessLaunchView {
  readonly launchId: string
  readonly subjectId: string
  readonly state: CoreHarnessState
  readonly url?: string
  readonly failure?: Readonly<{ code: string; message: string }>
  readonly pid?: number
  readonly directory: string
  readonly port: LauncherHarnessPortSetting
  readonly diagnostics: CoreHarnessDiagnostics
  readonly startedAt?: number
}

/** One console record the core retained. */
export interface CoreHarnessConsoleEntry {
  readonly seq: number
  readonly stream: string
  readonly text: string
  readonly occurredAt: number
}

/** Everything one launch needs, all of it facts the shell owns. */
export interface CoreHarnessLaunchRequest {
  readonly launchId: string
  readonly subjectId: string
  readonly directory: string
  readonly pnpmExecutable: string
  readonly pnpmPrefixArguments: readonly string[]
  readonly pnpmResolutionError: string
  readonly pnpmCommandSearchPath: string
  readonly diagnosticsPatchPath: string
  readonly port: LauncherHarnessPortSetting
  readonly logPath: string
}

/** The DSH Web operations the shell performs, wherever they are served. */
export interface CoreHarnessRuntimePort {
  start(request: CoreHarnessLaunchRequest, signal?: AbortSignal): Promise<CoreHarnessLaunchView>
  stop(subjectId: string, signal?: AbortSignal): Promise<CoreHarnessLaunchView>
  status(subjectId: string, signal?: AbortSignal): Promise<CoreHarnessLaunchView | undefined>
  console(
    cursor: number,
    signal?: AbortSignal
  ): Promise<Readonly<{ entries: readonly CoreHarnessConsoleEntry[]; cursor: number }>>
  portGet(filePath: string, signal?: AbortSignal): Promise<LauncherHarnessPortSetting>
  portSet(
    filePath: string,
    port: LauncherHarnessPortSetting,
    signal?: AbortSignal
  ): Promise<LauncherHarnessPortSetting>
}

const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function portOf(value: unknown): LauncherHarnessPortSetting {
  if (!isRecord(value)) throw new PeerHelperError('p2p.invalid_payload')
  if (value.mode === 'auto') return { mode: 'auto' }
  if (value.mode === 'fixed' && typeof value.port === 'number') {
    return { mode: 'fixed', port: value.port }
  }
  throw new PeerHelperError('p2p.invalid_payload')
}

function launchViewOf(value: unknown): CoreHarnessLaunchView {
  if (!isRecord(value) || !isRecord(value.launch)) throw new PeerHelperError('p2p.invalid_payload')
  const launch = value.launch
  const state = launch.state
  if (state !== 'starting' && state !== 'running' && state !== 'stopped' && state !== 'failed') {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  if (typeof launch.launchId !== 'string' || typeof launch.subjectId !== 'string') {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  const failure = isRecord(launch.failure)
    ? {
        code: String(launch.failure.code),
        message: String(launch.failure.message)
      }
    : undefined
  return {
    launchId: launch.launchId,
    subjectId: launch.subjectId,
    state,
    url: typeof launch.url === 'string' && launch.url.length > 0 ? launch.url : undefined,
    failure,
    pid: typeof launch.pid === 'number' ? launch.pid : undefined,
    directory: typeof launch.directory === 'string' ? launch.directory : '',
    port: portOf(launch.port),
    diagnostics: diagnosticsOf(launch.diagnostics),
    startedAt: typeof launch.startedAt === 'number' ? launch.startedAt : undefined
  }
}

function diagnosticsOf(value: unknown): CoreHarnessDiagnostics {
  if (!isRecord(value)) throw new PeerHelperError('p2p.invalid_payload')
  return {
    stdoutBytes: Number(value.stdoutBytes ?? 0),
    stderrBytes: Number(value.stderrBytes ?? 0),
    stdoutTruncated: value.stdoutTruncated === true,
    stderrTruncated: value.stderrTruncated === true,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
    exitSignal: typeof value.exitSignal === 'string' ? value.exitSignal : undefined
  }
}

/** Calls the core.runtime_* methods of a live dshkerd over its private channel. */
export class CoreHarnessRuntime implements CoreHarnessRuntimePort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async start(
    request: CoreHarnessLaunchRequest,
    signal?: AbortSignal
  ): Promise<CoreHarnessLaunchView> {
    return launchViewOf(await this.#rpc.call('runtime.start', { ...request }, budget(signal)))
  }

  async stop(subjectId: string, signal?: AbortSignal): Promise<CoreHarnessLaunchView> {
    return launchViewOf(await this.#rpc.call('runtime.stop', { subjectId }, budget(signal)))
  }

  async status(
    subjectId: string,
    signal?: AbortSignal
  ): Promise<CoreHarnessLaunchView | undefined> {
    const answer = await this.#rpc.call('runtime.status', { subjectId }, budget(signal))
    if (!isRecord(answer) || answer.present !== true || !('launch' in answer)) return undefined
    return launchViewOf(answer)
  }

  async console(
    cursor: number,
    signal?: AbortSignal
  ): Promise<Readonly<{ entries: readonly CoreHarnessConsoleEntry[]; cursor: number }>> {
    const answer = await this.#rpc.call('runtime.console', { cursor }, budget(signal))
    if (!isRecord(answer) || !Array.isArray(answer.entries) || typeof answer.cursor !== 'number') {
      throw new PeerHelperError('p2p.invalid_payload')
    }
    const entries = answer.entries.map((entry) => {
      if (!isRecord(entry)) throw new PeerHelperError('p2p.invalid_payload')
      return {
        seq: Number(entry.seq ?? 0),
        stream: String(entry.stream ?? 'stdout'),
        text: String(entry.text ?? ''),
        occurredAt: Number(entry.occurredAt ?? 0)
      }
    })
    return { entries, cursor: answer.cursor }
  }

  async portGet(filePath: string, signal?: AbortSignal): Promise<LauncherHarnessPortSetting> {
    const answer = await this.#rpc.call('runtime.port_get', { filePath }, budget(signal))
    return portOf(isRecord(answer) ? answer.port : undefined)
  }

  async portSet(
    filePath: string,
    port: LauncherHarnessPortSetting,
    signal?: AbortSignal
  ): Promise<LauncherHarnessPortSetting> {
    const answer = await this.#rpc.call('runtime.port_set', { filePath, port }, budget(signal))
    return portOf(isRecord(answer) ? answer.port : undefined)
  }
}
