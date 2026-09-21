import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { authenticatePeer, readPeerLine } from '../p2p/bootstrap'
import { createPeerChannel, removePeerChannel } from '../p2p/private-channel'
import { PeerRpc, type PeerMainHandler } from '../p2p/rpc'
import { stopChild, verifyCoreExecutable } from '../p2p/supervisor'
import { exactPeerObject, PeerHelperError } from '../p2p/wire'

const execFileAsync = promisify(execFile)

/** Registration and endpoint discovery are exact-state operations, not path guesses. */
async function registeredHeadlessCore(
  executable: string,
  options: CoreSupervisorOptions
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      executable,
      ['autostart', 'status', '--state', options.stateRoot],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4096
      }
    )
    const state: unknown = JSON.parse(stdout)
    if (typeof state !== 'object' || state === null || Array.isArray(state))
      throw new PeerHelperError('p2p.invalid_result')
    const record = state as Record<string, unknown>
    if (
      typeof record.installed !== 'boolean' ||
      typeof record.mechanism !== 'string' ||
      (record.path !== undefined && typeof record.path !== 'string') ||
      Object.keys(record).some((key) => !['installed', 'mechanism', 'path'].includes(key))
    )
      throw new PeerHelperError('p2p.invalid_result')
    if (!record.installed) return false
    if (options.catalogRoot === undefined)
      throw new PeerHelperError('p2p.helper_configuration_required')
    const raw = await readFile(join(options.stateRoot, 'config.json'), 'utf8').catch(() => {
      throw new PeerHelperError('p2p.invalid_configuration')
    })
    let config: unknown
    try {
      config = JSON.parse(raw)
    } catch {
      throw new PeerHelperError('p2p.invalid_configuration')
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config))
      throw new PeerHelperError('p2p.invalid_configuration')
    const configRecord = config as Record<string, unknown>
    if (
      configRecord.version !== 1 ||
      configRecord.dataRoot !== options.dataRoot ||
      configRecord.catalogRoot !== options.catalogRoot
    )
      throw new PeerHelperError('p2p.autostart_conflict')
    return true
  } catch (error) {
    if (error instanceof PeerHelperError) throw error
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.includes('p2p.autostart_conflict'))
      throw new PeerHelperError('p2p.autostart_conflict')
    throw new PeerHelperError('p2p.autostart_unavailable')
  }
}

async function headlessEndpoint(
  stateRoot: string,
  signal: AbortSignal
): Promise<{
  socket: string
  secret: string
}> {
  while (!signal.aborted) {
    const raw = await readFile(join(stateRoot, 'core.json'), 'utf8').catch(() => undefined)
    if (raw !== undefined) {
      let record: Record<string, unknown>
      try {
        record = exactPeerObject(JSON.parse(raw), ['version', 'socket', 'secret'])
      } catch {
        throw new PeerHelperError('p2p.invalid_bootstrap')
      }
      if (
        record.version !== 1 ||
        typeof record.socket !== 'string' ||
        typeof record.secret !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.secret)
      )
        throw new PeerHelperError('p2p.invalid_bootstrap')
      return { socket: record.socket, secret: record.secret }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new PeerHelperError('p2p.helper_unavailable')
}

/** The core's argv names every persistent root explicitly. */
function coreArguments(options: CoreSupervisorOptions): string[] {
  const args = ['--data', options.dataRoot]
  if (options.catalogRoot !== undefined) args.push('--catalog', options.catalogRoot)
  args.push('--state', options.stateRoot)
  return args
}

export interface CoreSupervisorOptions {
  /** Main-owned packaged resources directory, never a renderer-selected path. */
  resourcesRoot: string
  /** Absolute, main-owned directory the core persists under (--data). */
  dataRoot: string
  /**
   * Absolute directory the core owns the device catalog in (--catalog). This is
   * the settings root the shell has always written `p2p-devices.json` to, so
   * the core adopts an existing record in place; a shell that cannot resolve a
   * settings root omits it and keeps the file itself.
   */
  catalogRoot?: string
  /** Explicit state directory for this Launcher's core/autostart registration. */
  stateRoot: string
  onUnavailable(error: PeerHelperError): void
}

/**
 * The dispatch the peer state machine attaches to. The channel exists before its
 * owner does — the core is started at app ready, the P2P module is composed
 * after it — so the callbacks are routed through one mutable slot, and a caller
 * that never attaches gets the same typed refusal the core itself would give.
 */
interface Dispatch {
  handler?: PeerMainHandler
  readonly listeners: Set<(error: PeerHelperError) => void>
}

/** Owns exactly one verified dshkerd child and terminates it with the shell. */
export class CoreSupervisor {
  /** OS pid of the supervised core, for diagnostics and test assertions. */
  readonly pid: number
  readonly #child: ChildProcessWithoutNullStreams | undefined
  readonly #exit: Promise<void> | undefined
  readonly #directory: string | undefined
  readonly #dispatch: Dispatch
  readonly rpc: PeerRpc
  readonly #attached: boolean
  #closing: Promise<void> | undefined

  private constructor(
    child: ChildProcessWithoutNullStreams | undefined,
    exit: Promise<void> | undefined,
    directory: string | undefined,
    rpc: PeerRpc,
    dispatch: Dispatch,
    onUnavailable: CoreSupervisorOptions['onUnavailable'],
    attached: boolean
  ) {
    this.pid = child?.pid ?? -1
    this.#child = child
    this.#exit = exit
    this.#directory = directory
    this.#dispatch = dispatch
    this.rpc = rpc
    this.#attached = attached
    if (exit) {
      void exit
        .then(() => this.close())
        .catch(() => {
          onUnavailable(new PeerHelperError('p2p.helper_cleanup_failed'))
        })
    }
  }

  /** Calls one core method on the shared private channel. */
  call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    return this.rpc.call(method, payload, signal)
  }

  /**
   * Serves the parent-role callbacks the core sends. The channel outlives
   * the caller, so the returned function detaches the handler rather than
   * closing anything.
   */
  serve(handler: PeerMainHandler): () => void {
    this.#dispatch.handler = handler
    return () => {
      if (this.#dispatch.handler === handler) this.#dispatch.handler = undefined
    }
  }

  /** Observes the channel's death; returns the unregister function. */
  observe(listener: (error: PeerHelperError) => void): () => void {
    this.#dispatch.listeners.add(listener)
    return () => {
      this.#dispatch.listeners.delete(listener)
    }
  }

  static async start(options: CoreSupervisorOptions, signal: AbortSignal): Promise<CoreSupervisor> {
    if (!isAbsolute(options.dataRoot)) throw new PeerHelperError('p2p.invalid_arguments')
    if (options.catalogRoot !== undefined && !isAbsolute(options.catalogRoot))
      throw new PeerHelperError('p2p.invalid_arguments')
    if (!isAbsolute(options.stateRoot)) throw new PeerHelperError('p2p.invalid_arguments')
    try {
      await mkdir(options.dataRoot, { recursive: true })
      if (options.catalogRoot !== undefined) await mkdir(options.catalogRoot, { recursive: true })
      await mkdir(options.stateRoot, { recursive: true, mode: 0o700 })
    } catch {
      throw new PeerHelperError('p2p.invalid_arguments')
    }
    const dataInfo = await lstat(options.dataRoot).catch(() => undefined)
    if (!dataInfo?.isDirectory()) throw new PeerHelperError('p2p.invalid_arguments')
    // lstat never follows the final component, so a symlinked catalog directory
    // is refused here exactly as the core's own Open refuses it.
    if (options.catalogRoot !== undefined) {
      const catalogInfo = await lstat(options.catalogRoot).catch(() => undefined)
      if (!catalogInfo?.isDirectory() || catalogInfo.isSymbolicLink())
        throw new PeerHelperError('p2p.invalid_arguments')
    }
    const stateInfo = await lstat(options.stateRoot).catch(() => undefined)
    if (!stateInfo?.isDirectory() || stateInfo.isSymbolicLink())
      throw new PeerHelperError('p2p.invalid_arguments')
    if (process.platform !== 'win32') {
      await chmod(options.stateRoot, 0o700).catch(() => {
        throw new PeerHelperError('p2p.invalid_arguments')
      })
    }

    const executable = await verifyCoreExecutable(options.resourcesRoot)
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    if (await registeredHeadlessCore(executable, options)) return this.#attach(options, signal)
    const { directory, path: socketPath } = await createPeerChannel()
    const child = spawn(executable, coreArguments(options), {
      stdio: 'pipe',
      windowsHide: true,
      env: { ...process.env }
    })
    // A handshake that fails on one platform and not another cannot be argued
    // about from the outside: keep the exact bytes the core sent, and where the
    // shell got to, in a file next to the core's own state. It stays tiny and is
    // only written on failure.
    let announcementBytes = Buffer.alloc(0)
    const diagnose = (message: string): void => {
      void appendFile(
        join(options.dataRoot, 'core-diagnostics.log'),
        `${new Date().toISOString()} ${message}\n`,
        'utf8'
      ).catch(() => undefined)
    }
    const tap = (chunk: Buffer): void => {
      if (announcementBytes.length < 512)
        announcementBytes = Buffer.concat([
          announcementBytes,
          chunk.subarray(0, 512 - announcementBytes.length)
        ])
    }
    child.stdout.on('data', tap)
    const exit = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        diagnose(
          `exit code=${String(code)} signal=${String(signal)} announcement=${JSON.stringify(announcementBytes.toString('utf8'))}`
        )
        resolve()
      })
    })
    child.on('error', (error) => diagnose(`spawn-error ${String(error)}`))
    child.stdin.on('error', () => undefined)
    if (process.env.DSH_P2P_TRACE === '1')
      child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    else child.stderr.resume()
    const budget = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    let rpc: PeerRpc | undefined
    try {
      const secret = randomBytes(32).toString('hex')
      const ready = readPeerLine(child.stdout, budget)
      child.stdin.end(JSON.stringify({ version: 1, socket: socketPath, secret }))
      let announcement: Record<string, unknown>
      try {
        announcement = exactPeerObject(await ready, ['version', 'ready'])
      } catch (error) {
        // This first line is the whole handshake, so a core that says anything else
        // is otherwise indistinguishable from one that said nothing at all.
        diagnose(
          `handshake-failed raw=${JSON.stringify(announcementBytes.toString('utf8'))} ${String(error)}`
        )
        console.error('[p2p] core handshake failed:', error)
        throw error
      }
      child.stdout.off('data', tap)
      if (announcement.version !== 1 || announcement.ready !== true) {
        diagnose(`handshake-rejected ${JSON.stringify(announcement)}`)
        console.error('[p2p] core handshake rejected:', JSON.stringify(announcement))
        throw new PeerHelperError('p2p.protocol_mismatch')
      }
      const socket = await authenticatePeer(socketPath, secret, budget).catch((error: unknown) => {
        diagnose(`authenticate-failed socket=${socketPath} ${String(error)}`)
        throw error
      })
      // The core calls back once a device is restored: runtime.connect for the
      // runtime owner, peer.state for every connection stage, and
      // directory.changed for every new directory revision. Until the peer
      // state machine attaches, every inbound method is a typed not-implemented
      // rather than a silent hang.
      const dispatch: Dispatch = { listeners: new Set() }
      rpc = new PeerRpc(
        socket,
        (method, payload, callSignal) =>
          dispatch.handler === undefined
            ? Promise.reject(new PeerHelperError('p2p.not_implemented'))
            : dispatch.handler(method, payload, callSignal),
        (error) => {
          options.onUnavailable(error)
          for (const listener of dispatch.listeners) listener(error)
        }
      )
      if (budget.aborted) throw new PeerHelperError('p2p.request_cancelled')
      // readPeerLine pauses the socket; an explicitly paused stream does not
      // auto-resume when PeerRpc attaches its listener, so restart the flow
      // before any probe call. The peer supervisor does the same.
      // Only the announcement travels on this stream: from here the shell talks to
      // the core over its own socket, so anything the core prints afterwards is
      // console noise. Treating it as a protocol violation closed the channel on a
      // core that merely said something, which surfaced as "cannot sign in at all".
      child.stdout.on('data', (chunk: Buffer) => {
        if (process.env.DSH_P2P_TRACE === '1') process.stderr.write(chunk)
      })
      child.stdout.resume()
      socket.resume()
      // The version probe proves the core serves before the shell adopts it.
      const version = await rpc.call('core.version', {}, budget).catch((error: unknown) => {
        diagnose(`version-probe-failed ${String(error)}`)
        throw error
      })
      if (
        typeof version !== 'object' ||
        version === null ||
        (version as { version?: unknown }).version !== 1
      ) {
        diagnose(`version-rejected ${JSON.stringify(version)}`)
        throw new PeerHelperError('p2p.protocol_mismatch')
      }
      diagnose(`ready core.version=${JSON.stringify(version)}`)
      return new CoreSupervisor(child, exit, directory, rpc, dispatch, options.onUnavailable, false)
    } catch (error) {
      rpc?.close()
      child.kill()
      await stopChild(child, exit)
      if (directory) await removePeerChannel(directory)
      throw error
    }
  }

  /** The registered headless core is the sole identity owner; the desktop attaches. */
  static async #attach(
    options: CoreSupervisorOptions,
    signal: AbortSignal
  ): Promise<CoreSupervisor> {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const endpoint = await headlessEndpoint(options.stateRoot, budget)
    const socket = await authenticatePeer(endpoint.socket, endpoint.secret, budget)
    const dispatch: Dispatch = { listeners: new Set() }
    const rpc = new PeerRpc(
      socket,
      (method, payload, callSignal) =>
        dispatch.handler === undefined
          ? Promise.reject(new PeerHelperError('p2p.not_implemented'))
          : dispatch.handler(method, payload, callSignal),
      (error) => {
        options.onUnavailable(error)
        for (const listener of dispatch.listeners) listener(error)
      }
    )
    socket.resume()
    try {
      const attached = exactPeerObject(await rpc.call('core.desktop_attach', {}, budget), [
        'attached'
      ])
      if (attached.attached !== true) throw new PeerHelperError('p2p.protocol_mismatch')
      const version = exactPeerObject(await rpc.call('core.version', {}, budget), [
        'version',
        'methodTableVersion',
        'methods'
      ])
      if (
        version.version !== 1 ||
        version.methodTableVersion !== 1 ||
        !Array.isArray(version.methods)
      )
        throw new PeerHelperError('p2p.protocol_mismatch')
      return new CoreSupervisor(
        undefined,
        undefined,
        undefined,
        rpc,
        dispatch,
        options.onUnavailable,
        true
      )
    } catch (error) {
      rpc.close()
      throw error
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#stop()
    return this.#closing
  }

  async #stop(): Promise<void> {
    if (this.#attached) await this.#handoff()
    this.rpc.close()
    if (this.#child && this.#exit) await stopChild(this.#child, this.#exit)
    if (this.#directory) await removePeerChannel(this.#directory)
  }

  /**
   * A headless core remains the identity owner while the desktop is open. When
   * autostart was disabled during this session it must be told to relinquish
   * the owner only after the response has reached the desktop; closing the
   * socket first makes the Go side race its response against disconnect.
   */
  async #handoff(): Promise<void> {
    try {
      const result = exactPeerObject(
        await this.rpc.call('core.desktop_handoff', {}, AbortSignal.timeout(5_000)),
        ['handoff']
      )
      if (result.handoff !== true) throw new PeerHelperError('p2p.protocol_mismatch')
    } catch (error) {
      // The registration is still enabled: the headless process should detach
      // and continue serving, so it explicitly refuses a handoff. A dead core
      // is already gone and must not prevent the desktop from quitting.
      if (
        error instanceof PeerHelperError &&
        (error.code === 'p2p.autostart_conflict' || error.code === 'p2p.helper_unavailable')
      )
        return
      throw error
    }
  }
}
