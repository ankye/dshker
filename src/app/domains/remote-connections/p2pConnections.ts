import { reactive } from 'vue'
import type { P2PConnectionView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

/** Stages that mean a connection attempt is still in progress. */
const IN_FLIGHT: readonly P2PConnectionView['stage'][] = ['punching', 'starting-runtime']

export interface P2PConnectionsState {
  peers: P2PConnectionView[] | undefined
  /** Last helper-level error, separate from any one connection's failure. */
  helperError: string
  resultUnconfirmed: boolean
  /**
   * The code of the last refused connect or disconnect, or an empty string.
   *
   * A refusal that proves nothing happened is not a failure of the connection, so
   * it does not become one — but discarding it entirely left a button that answered
   * with nothing at all, which is indistinguishable from a broken one.
   */
  lastRefusal: string
}

/**
 * Public connection state for the renderer.
 *
 * `ready` is the only stage that means a workbench is usable, and it is
 * reported by main only when a real direct path and runtime generation exist.
 * Nothing here holds a DSH URL, cookie or token: an address is asked for
 * separately, by `entry`, for one named attempt.
 */
export class P2PConnectionsDomain {
  readonly #state = reactive<P2PConnectionsState>({
    peers: undefined,
    helperError: '',
    resultUnconfirmed: false,
    lastRefusal: ''
  })
  #polling: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly management: P2PManagementDomain) {}

  /**
   * Keeps stages current while an attempt is in flight.
   *
   * Stages advance asynchronously in the helper; without a follow-up read the
   * UI would keep showing the first stage until the user clicks something.
   * Polling stops as soon as no peer is negotiating.
   */
  #scheduleFollowUp(): void {
    if (this.#polling !== undefined) return
    this.#polling = setTimeout(() => {
      this.#polling = undefined
      const inFlight = (this.#state.peers ?? []).some(
        (peer) => peer.stage === 'punching' || peer.stage === 'starting-runtime'
      )
      if (!inFlight) return
      void this.read().then(() => this.#scheduleFollowUp())
    }, 2000)
  }

  get state(): P2PConnectionsState {
    return this.#state
  }

  /** Reading is always allowed and is how an unknown outcome is resolved. */
  async read(): Promise<void> {
    const result = await this.management.run('connections', {})
    if (result.ok) {
      this.#state.peers = result.data.peers
      this.#state.helperError = result.data.error
      this.#state.resultUnconfirmed = false
      this.#scheduleFollowUp()
    }
  }

  /** The live stage for one pair, or undefined when it has never connected. */
  find(serviceId: string, pairId: string): P2PConnectionView | undefined {
    return this.#state.peers?.find((peer) => peer.serviceId === serviceId && peer.pairId === pairId)
  }

  /** True only for a fully established workbench. */
  isReady(serviceId: string, pairId: string): boolean {
    return this.find(serviceId, pairId)?.stage === 'ready'
  }

  /** True while an attempt is still negotiating; never treated as connected. */
  isConnecting(serviceId: string, pairId: string): boolean {
    const stage = this.find(serviceId, pairId)?.stage
    return stage !== undefined && IN_FLIGHT.includes(stage)
  }

  /** A direct path is required for `ready`; relayed transport is not offered. */
  isDirect(serviceId: string, pairId: string): boolean {
    const path = this.find(serviceId, pairId)?.path
    return path !== undefined && path.protocol === 'udp' && path.localType !== ''
  }

  async connect(serviceId: string, pairId: string): Promise<void> {
    if (!this.#canWrite(serviceId) || this.isConnecting(serviceId, pairId)) return
    const result = await this.management.run('connect', { serviceId, pairId })
    this.#state.lastRefusal = result.ok ? '' : result.code
    if (!result.ok) this.#recordWriteOutcome(result.code)
    // Dispatch only starts an attempt, so the stage arrives through a readback.
    // A refusal is read back the same way, and that is the whole point: reading is
    // how an unknown outcome is resolved, so skipping it left this window holding a
    // result it could never clear — a connect button that answered every later
    // press with silence.
    await this.read()
  }

  async disconnect(serviceId: string, pairId: string): Promise<void> {
    if (!this.#canWrite(serviceId)) return
    const result = await this.management.run('disconnect', { serviceId, pairId })
    this.#state.lastRefusal = result.ok ? '' : result.code
    if (!result.ok) this.#recordWriteOutcome(result.code)
    await this.read()
  }

  /**
   * The workbench address of a connected peer, for the tab that renders it.
   *
   * Main owns the address — it is a loopback gateway with a token — and answers
   * only for the attempt the caller names, so a tab that has moved on cannot be
   * handed a gateway its session no longer owns. A refusal is returned rather
   * than thrown: an address that is not available yet is an ordinary state of a
   * tab, not a failure of the run page.
   */
  async entry(
    serviceId: string,
    pairId: string,
    generation: number
  ): Promise<{ url: string; partition: string } | undefined> {
    const result = await this.management.run('entry', { serviceId, pairId, generation })
    return result.ok ? { url: result.data.url, partition: result.data.partition } : undefined
  }

  #canWrite(serviceId: string): boolean {
    return !this.management.busy(serviceId) && !this.#state.resultUnconfirmed
  }

  /**
   * Codes that prove the request never took effect leave state clean; anything
   * else may have started or torn down a session, so it counts as unknown.
   *
   * The two busy refusals belong in the first group for the same reason as the
   * rest: the boundary that refused them is the one that decides whether a
   * request is dispatched at all, so nothing was started. Counting them as
   * unknown blocked every later attempt from this page — a refusal the user could
   * neither see nor get past.
   */
  #recordWriteOutcome(code: string): void {
    const rejectedBeforeEffect = [
      'bridge',
      'p2p.connection_busy',
      'p2p.connection_not_found',
      'p2p.helper_busy',
      'p2p.invalid_request',
      'p2p.pair_not_found',
      'p2p.pair_state_mismatch',
      'p2p.service_busy',
      'p2p.device_unregistered',
      'p2p.not_enabled',
      'p2p.request_cancelled'
    ]
    if (!rejectedBeforeEffect.includes(code)) {
      this.#state.resultUnconfirmed = true
      // Reading is how an unknown outcome is resolved, and the user must not have
      // to visit another page to make that happen: the states that block a retry
      // are exactly the ones a read clears.
      void this.read()
    }
  }
}

export const p2pConnections = new P2PConnectionsDomain(p2pManagement)
