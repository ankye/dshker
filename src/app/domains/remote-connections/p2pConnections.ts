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
}

/**
 * Public connection state for the renderer.
 *
 * `ready` is the only stage that means a workbench is usable, and it is
 * reported by main only when a real direct path and runtime generation exist.
 * Nothing here holds a DSH URL, cookie or token: the local entry point stays in
 * main and reaches only the restricted Run guest.
 */
export class P2PConnectionsDomain {
  readonly #state = reactive<P2PConnectionsState>({
    peers: undefined,
    helperError: '',
    resultUnconfirmed: false
  })
  constructor(private readonly management: P2PManagementDomain) {}

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
    // Dispatch only starts an attempt; the stage arrives through a readback.
    if (result.ok) await this.read()
    else this.#recordWriteOutcome(result.code)
  }

  async disconnect(serviceId: string, pairId: string): Promise<void> {
    if (!this.#canWrite(serviceId)) return
    const result = await this.management.run('disconnect', { serviceId, pairId })
    if (result.ok) await this.read()
    else this.#recordWriteOutcome(result.code)
  }

  #canWrite(serviceId: string): boolean {
    return !this.management.busy(serviceId) && !this.#state.resultUnconfirmed
  }

  /**
   * Codes that prove the request never took effect leave state clean; anything
   * else may have started or torn down a session, so it counts as unknown.
   */
  #recordWriteOutcome(code: string): void {
    const rejectedBeforeEffect = [
      'bridge',
      'p2p.connection_busy',
      'p2p.connection_not_found',
      'p2p.invalid_request',
      'p2p.pair_not_found',
      'p2p.pair_state_mismatch',
      'p2p.device_unregistered',
      'p2p.not_enabled',
      'p2p.request_cancelled'
    ]
    if (!rejectedBeforeEffect.includes(code)) this.#state.resultUnconfirmed = true
  }
}

export const p2pConnections = new P2PConnectionsDomain(p2pManagement)
