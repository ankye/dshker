import type { PeerHelperState } from './helper-state'
import { parseHelperState } from './helper-state'
import { assertAccountId } from './account-records'
import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

/** 2026-01-01T00:00:00Z: the epoch attempt generations are seeded from. */
const GENERATION_EPOCH_MILLISECONDS = 1_767_225_600_000

/**
 * Main-only connection operations for paired computers.
 *
 * Each attempt gets a monotonically increasing generation, while operation
 * revisions fence entry readbacks against disconnect and authorization changes.
 * Workbench addresses are read separately from the current core owner.
 */
export class PeerConnections {
  readonly #entryRevisions = new Map<string, number>()
  readonly #busy = new Set<string>()
  #generation = 0
  #closed = false

  constructor(private readonly rpc: Pick<PeerRpc, 'call'>) {}

  /**
   * Names the next attempt of this process.
   *
   * A counter starting at 1 names every attempt of a restarted process "older"
   * than the ones a previous process made: a peer that orders attempts by
   * generation alone rejects the fresh attempt as stale, and the connection
   * dies as p2p.runtime_request_unscoped until that peer restarts. Seeding from
   * the clock makes each process start above everything an earlier one could
   * have counted, so a fresh attempt is always the newest any peer has seen —
   * including peers running builds that never learned attempt lineages.
   */
  #nextGeneration(): number {
    const seeded = Math.max(Date.now() - GENERATION_EPOCH_MILLISECONDS, 1)
    this.#generation = Math.max(this.#generation + 1, seeded)
    return this.#generation
  }

  close(): void {
    this.#closed = true
  }

  /**
   * Starts one connection attempt.
   *
   * Returns the accepted attempt state, which is never `ready`: reaching a
   * usable workbench requires the helper to report progress through
   * `peer.state`, so a caller cannot treat dispatch as success.
   */
  async connect(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerHelperState> {
    assertAccountId(serviceId, 12)
    assertAccountId(pairId)
    return this.#operation(serviceId, pairId, async () => {
      this.invalidate(serviceId, pairId)
      const generation = this.#nextGeneration()
      const reply = await this.rpc.call(
        'peer.connect',
        { serviceId, data: { pairId, generation, requestWorkbench: true } },
        signal
      )
      const record = exactPeerObject(reply, ['state', 'url'])
      const state = parseHelperState(record.state)
      if (state.pairId !== pairId) throw new PeerHelperError('p2p.identity_mismatch')
      if (state.generation !== generation) throw new PeerHelperError('p2p.stale_generation')
      if (typeof record.url !== 'string') throw new PeerHelperError('p2p.invalid_socket')
      // An address is what a workbench has, not what a connection needs.
      //
      // Requiring one here rejected a perfectly good link whenever the far side
      // had no workbench to offer — a machine whose dependencies could not be
      // resolved, or one that simply is not running DSH. The two computers were
      // connected and the shell threw the connection away, so everything else the
      // link carries was lost for a reason that has nothing to do with it.
      // Discard the dispatch URL: only peer.entry proves the current ready gateway.
      return state
    })
  }

  /** Tears down a connection and invalidates pending entry reads. */
  async disconnect(serviceId: string, pairId: string, signal: AbortSignal): Promise<void> {
    assertAccountId(serviceId, 12)
    assertAccountId(pairId)
    await this.#operation(serviceId, pairId, async () => {
      // Fence reads first, even if teardown fails before a stage callback arrives.
      this.invalidate(serviceId, pairId)
      exactPeerObject(
        await this.rpc.call('peer.disconnect', { serviceId, data: { pairId } }, signal),
        []
      )
      return undefined
    })
  }

  /** Invalidates pending entry reads for one pair or every pair of a service. */
  invalidate(serviceId: string, pairId?: string): void {
    const revisionKey = pairId ? this.#key(serviceId, pairId) : serviceId
    this.#entryRevisions.set(revisionKey, (this.#entryRevisions.get(revisionKey) ?? 0) + 1)
  }

  /** Fences a read against main operations before their stage callback arrives. */
  guardEntry(serviceId: string, pairId: string): () => void {
    const key = this.#key(serviceId, pairId)
    const serviceRevision = this.#entryRevisions.get(serviceId)
    const pairRevision = this.#entryRevisions.get(key)
    const assertCurrent = () => {
      this.#admit()
      if (
        this.#entryRevisions.get(serviceId) !== serviceRevision ||
        this.#entryRevisions.get(key) !== pairRevision
      )
        throw new PeerHelperError('p2p.stale_generation')
      if (this.#busy.has(key)) throw new PeerHelperError('p2p.connection_busy')
    }
    assertCurrent()
    return assertCurrent
  }

  #key(serviceId: string, pairId: string): string {
    return `${serviceId}:${pairId}`
  }

  /** One in-flight connection operation per pair. */
  async #operation<T>(serviceId: string, pairId: string, operation: () => Promise<T>): Promise<T> {
    this.#admit()
    const key = this.#key(serviceId, pairId)
    if (this.#busy.has(key)) throw new PeerHelperError('p2p.connection_busy')
    this.#busy.add(key)
    try {
      return await operation()
    } finally {
      this.#busy.delete(key)
    }
  }

  #admit(): void {
    if (this.#closed) throw new PeerHelperError('p2p.helper_closed')
  }
}
