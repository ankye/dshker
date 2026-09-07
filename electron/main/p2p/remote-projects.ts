import { assertAccountId } from './account-records'
import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

/**
 * Main-only remote authorized roots and directory browsing.
 *
 * All path semantics belong to the remote computer: it resolves its own drive
 * letters, case rules, reserved names, Unicode forms, symlinks and junctions,
 * and it decides whether a location really sits inside an authorized root. This
 * side only forwards opaque references it received, so it can neither widen the
 * granted scope nor reach a path the remote user never authorized.
 *
 * This is deliberately not a general file capability: there is no read, write,
 * delete or shell operation, and opening a project still goes through the remote
 * DSH's own permission and approval policy.
 */

export interface PeerRemoteRoot {
  rootId: string
  name: string
  path: string
}

export interface PeerRemoteEntry {
  ref: string
  name: string
  isDirectory: boolean
  isProject: boolean
}

/** One listing page is bounded to match the remote server's own cap. */
export const MAX_REMOTE_ENTRIES = 500

export class PeerRemoteProjects {
  readonly #busy = new Set<string>()
  #closed = false

  constructor(
    private readonly rpc: Pick<PeerRpc, 'call'>,
    /** Proves the pair is an active, authorized computer before any request. */
    private readonly authorize: (serviceId: string, pairId: string) => Promise<void>
  ) {}

  close(): void {
    this.#closed = true
  }

  /** Reads the roots the remote user explicitly authorized. */
  async roots(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerRemoteRoot[]> {
    assertAccountId(serviceId, 64)
    assertAccountId(pairId)
    return this.#operation(serviceId, pairId, async () => {
      await this.authorize(serviceId, pairId)
      const reply = exactPeerObject(
        await this.rpc.call('remote.roots', { serviceId, data: { pairId } }, signal),
        ['roots']
      )
      if (!Array.isArray(reply.roots)) throw new PeerHelperError('p2p.invalid_server_response')
      const roots = reply.roots.map((value) => this.#root(value))
      if (new Set(roots.map((root) => root.rootId)).size !== roots.length)
        throw new PeerHelperError('p2p.invalid_server_response')
      return roots
    })
  }

  /**
   * Reads one bounded page inside an authorized root.
   *
   * An empty `ref` means the root itself. Any other value must be a reference
   * the remote computer issued earlier.
   */
  async directory(
    serviceId: string,
    pairId: string,
    rootId: string,
    ref: string,
    offset: number,
    limit: number,
    signal: AbortSignal
  ): Promise<{ entries: PeerRemoteEntry[]; total: number }> {
    assertAccountId(serviceId, 64)
    assertAccountId(pairId)
    if (typeof rootId !== 'string' || rootId === '' || rootId.length > 128)
      throw new PeerHelperError('p2p.invalid_request')
    // The reference is opaque: bounded and shape-checked, never interpreted.
    if (
      typeof ref !== 'string' ||
      ref.length > 4096 ||
      (ref !== '' && !/^[A-Za-z0-9_-]+$/.test(ref))
    )
      throw new PeerHelperError('p2p.remote_reference_invalid')
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new PeerHelperError('p2p.invalid_request')
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_REMOTE_ENTRIES)
      throw new PeerHelperError('p2p.invalid_request')
    return this.#operation(serviceId, pairId, async () => {
      await this.authorize(serviceId, pairId)
      const reply = exactPeerObject(
        await this.rpc.call(
          'remote.directory',
          { serviceId, data: { pairId, rootId, ref, offset, limit } },
          signal
        ),
        ['entries', 'total']
      )
      if (!Array.isArray(reply.entries) || !Number.isSafeInteger(reply.total))
        throw new PeerHelperError('p2p.invalid_server_response')
      const total = reply.total as number
      if (total < 0) throw new PeerHelperError('p2p.invalid_server_response')
      const entries = reply.entries.map((value) => this.#entry(value))
      // A page cannot exceed its own request or the declared total.
      if (entries.length > limit || entries.length > total)
        throw new PeerHelperError('p2p.invalid_server_response')
      if (new Set(entries.map((entry) => entry.ref)).size !== entries.length)
        throw new PeerHelperError('p2p.invalid_server_response')
      return { entries, total }
    })
  }

  #root(value: unknown): PeerRemoteRoot {
    const record = exactPeerObject(value, ['rootId', 'name', 'path'])
    if (
      typeof record.rootId !== 'string' ||
      record.rootId === '' ||
      record.rootId.length > 128 ||
      typeof record.name !== 'string' ||
      record.name === '' ||
      record.name.length > 256 ||
      typeof record.path !== 'string' ||
      record.path === '' ||
      record.path.length > 4096
    )
      throw new PeerHelperError('p2p.invalid_server_response')
    return { rootId: record.rootId, name: record.name, path: record.path }
  }

  #entry(value: unknown): PeerRemoteEntry {
    const record = exactPeerObject(value, ['ref', 'name', 'isDirectory', 'isProject'])
    if (
      typeof record.ref !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(record.ref) ||
      record.ref.length > 4096 ||
      typeof record.name !== 'string' ||
      record.name === '' ||
      record.name.length > 512 ||
      typeof record.isDirectory !== 'boolean' ||
      typeof record.isProject !== 'boolean'
    )
      throw new PeerHelperError('p2p.invalid_server_response')
    return {
      ref: record.ref,
      name: record.name,
      isDirectory: record.isDirectory,
      isProject: record.isProject
    }
  }

  /** One in-flight browse per pair, so paging cannot interleave. */
  async #operation<T>(serviceId: string, pairId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new PeerHelperError('p2p.helper_closed')
    const key = `${serviceId}:${pairId}`
    if (this.#busy.has(key)) throw new PeerHelperError('p2p.service_busy')
    this.#busy.add(key)
    try {
      return await operation()
    } finally {
      this.#busy.delete(key)
    }
  }
}
