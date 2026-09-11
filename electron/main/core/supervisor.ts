import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { authenticatePeer, readPeerLine } from '../p2p/bootstrap'
import { createPeerChannel, removePeerChannel } from '../p2p/private-channel'
import { PeerRpc, type PeerMainHandler } from '../p2p/rpc'
import { stopChild, verifyHelperResource } from '../p2p/supervisor'
import { exactPeerObject, PeerHelperError } from '../p2p/wire'

export interface CoreSupervisorOptions {
  /** Main-owned packaged resources directory, never a renderer-selected path. */
  resourcesRoot: string
  /** Absolute, main-owned directory the core persists under (--data). */
  dataRoot: string
  onUnavailable(error: PeerHelperError): void
}

/** Owns exactly one verified dshkerd child and terminates it with the shell. */
export class CoreSupervisor {
  /** OS pid of the supervised core, for diagnostics and test assertions. */
  readonly pid: number
  readonly #child: ChildProcessWithoutNullStreams
  readonly #exit: Promise<void>
  readonly #directory: string | undefined
  readonly rpc: PeerRpc
  #closing: Promise<void> | undefined

  private constructor(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<void>,
    directory: string | undefined,
    rpc: PeerRpc,
    onUnavailable: CoreSupervisorOptions['onUnavailable']
  ) {
    this.pid = child.pid ?? -1
    this.#child = child
    this.#exit = exit
    this.#directory = directory
    this.rpc = rpc
    void exit
      .then(() => this.close())
      .catch(() => {
        onUnavailable(new PeerHelperError('p2p.helper_cleanup_failed'))
      })
  }

  static async start(options: CoreSupervisorOptions, signal: AbortSignal): Promise<CoreSupervisor> {
    if (!isAbsolute(options.dataRoot)) throw new PeerHelperError('p2p.invalid_arguments')
    try {
      await mkdir(options.dataRoot, { recursive: true })
    } catch {
      throw new PeerHelperError('p2p.invalid_arguments')
    }
    const dataInfo = await lstat(options.dataRoot).catch(() => undefined)
    if (!dataInfo?.isDirectory()) throw new PeerHelperError('p2p.invalid_arguments')

    const executable = await verifyHelperResource(options.resourcesRoot, 'dshkerd')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    const { directory, path: socketPath } = await createPeerChannel()
    const child = spawn(executable, ['--data', options.dataRoot], {
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
      const announcement = exactPeerObject(await ready, ['version', 'ready'])
      if (announcement.version !== 1 || announcement.ready !== true)
        throw new PeerHelperError('p2p.protocol_mismatch')
      const socket = await authenticatePeer(socketPath, secret, budget)
      // The core never calls back before P2 routes state into it; every
      // inbound method is a typed not-implemented until then.
      const handler: PeerMainHandler = () =>
        Promise.reject(new PeerHelperError('p2p.not_implemented'))
      rpc = new PeerRpc(socket, handler, options.onUnavailable)
      if (budget.aborted) throw new PeerHelperError('p2p.request_cancelled')
      // readPeerLine pauses the socket; an explicitly paused stream does not
      // auto-resume when PeerRpc attaches its listener, so restart the flow
      // before any probe call. The peer supervisor does the same.
      child.stdout.on('data', () => rpc?.close(new PeerHelperError('p2p.protocol_mismatch')))
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
      return new CoreSupervisor(child, exit, directory, rpc, options.onUnavailable)
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
