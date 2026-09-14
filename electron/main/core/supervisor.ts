import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { authenticatePeer, readPeerLine } from '../p2p/bootstrap'
import { createPeerChannel, removePeerChannel } from '../p2p/private-channel'
import { PeerRpc, type PeerMainHandler } from '../p2p/rpc'
import { stopChild, verifyCoreExecutable } from '../p2p/supervisor'
import { exactPeerObject, PeerHelperError } from '../p2p/wire'

/** The core's argv: `--data` always, `--catalog` only when the shell owns a settings root. */
function coreArguments(options: CoreSupervisorOptions): string[] {
  const args = ['--data', options.dataRoot]
  if (options.catalogRoot !== undefined) args.push('--catalog', options.catalogRoot)
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
  readonly #child: ChildProcessWithoutNullStreams
  readonly #exit: Promise<void>
  readonly #directory: string | undefined
  readonly #dispatch: Dispatch
  readonly rpc: PeerRpc
  #closing: Promise<void> | undefined

  private constructor(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<void>,
    directory: string | undefined,
    rpc: PeerRpc,
    dispatch: Dispatch,
    onUnavailable: CoreSupervisorOptions['onUnavailable']
  ) {
    this.pid = child.pid ?? -1
    this.#child = child
    this.#exit = exit
    this.#directory = directory
    this.#dispatch = dispatch
    this.rpc = rpc
    void exit
      .then(() => this.close())
      .catch(() => {
        onUnavailable(new PeerHelperError('p2p.helper_cleanup_failed'))
      })
  }

  /** Calls one core method on the shared private channel. */
  call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    return this.rpc.call(method, payload, signal)
  }

  /**
   * Serves the two parent-role callbacks the core sends. The channel outlives
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
    try {
      await mkdir(options.dataRoot, { recursive: true })
      if (options.catalogRoot !== undefined) await mkdir(options.catalogRoot, { recursive: true })
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

    const executable = await verifyCoreExecutable(options.resourcesRoot)
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    const { directory, path: socketPath } = await createPeerChannel()
    const child = spawn(executable, coreArguments(options), {
      stdio: 'pipe',
      windowsHide: true,
      env: { ...process.env }
    })
    const exit = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
    })
    child.on('error', () => undefined)
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
        console.error('[p2p] core handshake failed:', error)
        throw error
      }
      if (announcement.version !== 1 || announcement.ready !== true) {
        console.error('[p2p] core handshake rejected:', JSON.stringify(announcement))
        throw new PeerHelperError('p2p.protocol_mismatch')
      }
      const socket = await authenticatePeer(socketPath, secret, budget)
      // The core calls back once a device is restored: runtime.connect for the
      // runtime owner and peer.state for every connection stage. Until the peer
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
      const version = await rpc.call('core.version', {}, budget)
      if (
        typeof version !== 'object' ||
        version === null ||
        (version as { version?: unknown }).version !== 1
      )
        throw new PeerHelperError('p2p.protocol_mismatch')
      return new CoreSupervisor(child, exit, directory, rpc, dispatch, options.onUnavailable)
    } catch (error) {
      rpc?.close()
      child.kill()
      await stopChild(child, exit)
      if (directory) await removePeerChannel(directory)
      throw error
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#stop()
    return this.#closing
  }

  async #stop(): Promise<void> {
    this.rpc.close()
    await stopChild(this.#child, this.#exit)
    if (this.#directory) await removePeerChannel(this.#directory)
  }
}
