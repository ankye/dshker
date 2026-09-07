import type { PeerHelperState } from './helper-state'
import { parseHelperState } from './helper-state'
import { assertAccountId } from './account-records'
import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

/**
 * Main-only connection operations for paired computers.
 *
 * Two things stay strictly inside main. The local DSH entry URL returned by the
 * helper is never projected to an ordinary renderer; it is retained here and
 * handed only to the restricted Run guest. And each attempt gets a
 * monotonically increasing generation so a late callback from a previous
 * attempt can be recognised and discarded rather than mistaken for progress.
 */
export class PeerConnections {
  /** Local entry URLs by `serviceId:pairId`. Main-only, never projected. */
  readonly #entries = new Map<string, { generation: number; url: string }>()
  readonly #busy = new Set<string>()
  #generation = 0
  #closed = false

  constructor(private readonly rpc: Pick<PeerRpc, 'call'>) {}

  close(): void {
    this.#closed = true
    this.#entries.clear()
  }

  /**
   * Starts one connection attempt.
   *
   * Returns the accepted attempt state, which is never `ready`: reaching a
   * usable workbench requires the helper to report progress through
   * `peer.state`, so a caller cannot treat dispatch as success.
   */
  async connect(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerHelperState> {
    assertAccountId(serviceId, 64)
    assertAccountId(pairId)
    return this.#operation(serviceId, pairId, async () => {
      const generation = ++this.#generation
      const reply = await this.rpc.call(
        'peer.connect',
        { serviceId, data: { pairId, generation } },
        signal
      )
      const record = exactPeerObject(reply, ['state', 'url'])
      const state = parseHelperState(record.state)
      if (state.pairId !== pairId) throw new PeerHelperError('p2p.identity_mismatch')
      if (state.generation !== generation) throw new PeerHelperError('p2p.stale_generation')
      if (typeof record.url !== 'string' || record.url === '')
        throw new PeerHelperError('p2p.invalid_socket')
      // The URL stops here. Only the Run guest receives it, through main.
      this.#entries.set(this.#key(serviceId, pairId), { generation, url: record.url })
      return state
    })
  }

  /** Tears down a connection and drops its local entry point. */
  async disconnect(serviceId: string, pairId: string, signal: AbortSignal): Promise<void> {
    assertAccountId(serviceId, 64)
    assertAccountId(pairId)
    await this.#operation(serviceId, pairId, async () => {
      // Drop the entry first: a failed teardown must not leave a usable URL.
      this.#entries.delete(this.#key(serviceId, pairId))
      exactPeerObject(
        await this.rpc.call('peer.disconnect', { serviceId, data: { pairId } }, signal),
        []
      )
      return undefined
    })
  }

  /**
   * Resolves the main-only entry URL for a connected peer.
   *
   * The generation must match the caller's expectation, so an entry point from
   * a superseded attempt is refused instead of silently reused.
   */
  entry(serviceId: string, pairId: string, generation: number): string {
    const found = this.#entries.get(this.#key(serviceId, pairId))
    if (!found) throw new PeerHelperError('p2p.connection_not_found')
    if (found.generation !== generation) throw new PeerHelperError('p2p.stale_generation')
    return found.url
  }

  /** Invalidates entry points for one pair, or for every pair of a service. */
  invalidate(serviceId: string, pairId?: string): void {
    if (pairId) {
      this.#entries.delete(this.#key(serviceId, pairId))
      return
    }
    for (const key of [...this.#entries.keys()])
      if (key.startsWith(`${serviceId}:`)) this.#entries.delete(key)
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
