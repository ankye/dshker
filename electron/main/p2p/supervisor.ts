import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createPeerChannel, removePeerChannel } from './private-channel'
import { authenticatePeer, readPeerLine } from './bootstrap'
import { PeerRpc, type PeerMainHandler } from './rpc'
import { exactPeerObject, parsePeerJson, PeerHelperError } from './wire'

export interface PeerSupervisorOptions {
  /** Main-owned packaged resources directory, never a renderer-selected path. */
  resourcesRoot: string
  handler: PeerMainHandler
  onUnavailable(error: PeerHelperError): void
}

/** Owns exactly one verified helper child; never resolves executables from PATH. */
export class PeerSupervisor {
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
    onUnavailable: PeerSupervisorOptions['onUnavailable']
  ) {
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

  static async start(options: PeerSupervisorOptions, signal: AbortSignal): Promise<PeerSupervisor> {
    const executable = await verifyHelperResource(options.resourcesRoot, 'dshker-peer')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    const { directory, path: socketPath } = await createPeerChannel()
    const child = spawn(executable, [], {
      stdio: 'pipe',
      windowsHide: true,
      env: { ...process.env }
    })
    const exit = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
    })
    // No child output contains user-facing copy or trusted diagnostics, so it is
    // discarded by default. Under DSH_P2P_TRACE it is forwarded instead: the
    // helper owns the coordinator conversation, and with its stderr dropped a
    // failure there was invisible from the main process log.
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
      rpc = new PeerRpc(socket, options.handler, options.onUnavailable)
      if (budget.aborted) throw new PeerHelperError('p2p.request_cancelled')
      child.stdout.on('data', () => rpc?.close(new PeerHelperError('p2p.protocol_mismatch')))
      child.stdout.resume()
      socket.resume()
      return new PeerSupervisor(child, exit, directory, rpc, options.onUnavailable)
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

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>
): Promise<void> {
  if (await exitedWithin(exit, 10_000)) return
  child.kill('SIGTERM')
  if (await exitedWithin(exit, 5_000)) return
  child.kill('SIGKILL')
  if (!(await exitedWithin(exit, 5_000))) throw new PeerHelperError('p2p.helper_shutdown_failed')
}

export function exitedWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds)
    void exit.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// The packaged helper directory holds two executables and two manifests:
// dshker-peer (manifest.json, frozen schema) and dshkerd
// (dshkerd-manifest.json). Both runtime-verify their own bytes.
export async function verifyHelperResource(
  root: string,
  name: 'dshker-peer' | 'dshkerd'
): Promise<string> {
  if (name !== 'dshker-peer' && name !== 'dshkerd')
    throw new PeerHelperError('p2p.invalid_arguments')
  if (
    !isAbsolute(root) ||
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  )
    throw new PeerHelperError('p2p.helper_platform_unsupported')
  const target = `${process.platform}-${process.arch}`
  const directory = join(root, 'p2p', target)
  const fileName = process.platform === 'win32' ? name + '.exe' : name
  const executable = join(directory, fileName)
  const manifestFile = name === 'dshkerd' ? 'dshkerd-manifest.json' : 'manifest.json'
  try {
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink()) throw new PeerHelperError('p2p.helper_invalid')
    const manifest = exactPeerObject(
      parsePeerJson(await readFile(join(directory, manifestFile), 'utf8')),
      ['version', 'target', 'file', 'sha256']
    )
    const digest = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex')
    if (
      manifest.version !== 1 ||
      manifest.target !== target ||
      manifest.file !== fileName ||
      manifest.sha256 !== digest
    )
      throw new PeerHelperError('p2p.helper_integrity_failed')
  } catch (error) {
    if (error instanceof PeerHelperError) throw error
    throw new PeerHelperError('p2p.helper_resource_unavailable')
  }
  return executable
}
