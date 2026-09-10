import { reactive } from 'vue'
import type { P2PServiceSessionView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PNetworkState {
  /**
   * This computer's session with each coordinator.
   *
   * `undefined` means not read yet, which is not the same as offline: the UI
   * must not claim a computer is offline before it has looked.
   */
  sessions: P2PServiceSessionView[] | undefined
}

/**
 * The network layer of remote connections: this computer's session with each
 * coordinator, shared by every surface that shows it.
 *
 * This is deliberately separate from `p2pConnections`, which tracks pair
 * connections. The two answer different questions:
 *
 * - Network session: am I online, discoverable, and able to pair? This is what
 *   presence and the reported build depend on.
 * - Pair connection: is one specific remote workbench reachable right now?
 *
 * Every surface previously derived its own answer, and the Connect tab derived a
 * network status from pair stages. A single enrolled computer was therefore
 * shown offline for a stage it could never reach, while the device directory
 * showed the same computer online from coordinator-reported presence. One shared
 * source removes the possibility of two surfaces disagreeing.
 */
export class P2PNetworkDomain {
  readonly #state = reactive<P2PNetworkState>({ sessions: undefined })
  constructor(private readonly management: P2PManagementDomain) {}

  get state(): P2PNetworkState {
    return this.#state
  }

  /** Reading states what the last attempt observed; it never starts a session. */
  async read(): Promise<void> {
    const result = await this.management.runRead('serviceSessions', {})
    if (result.ok) this.#state.sessions = result.data
  }

  /** The session for one service, or undefined while the list is unread. */
  find(serviceId: string): P2PServiceSessionView | undefined {
    return this.#state.sessions?.find((session) => session.serviceId === serviceId)
  }

  /**
   * Whether this computer holds a coordinator session.
   *
   * `undefined` while unread, so a caller can distinguish "not looked yet" from
   * a confirmed offline state instead of defaulting to a claim.
   */
  isOnline(serviceId: string): boolean | undefined {
    if (this.#state.sessions === undefined) return undefined
    return this.find(serviceId)?.state === 'online'
  }

  /** The refusal that kept a session down, empty when online or unread. */
  refusal(serviceId: string): string {
    return this.find(serviceId)?.code ?? ''
  }
}

export const p2pNetwork = new P2PNetworkDomain(p2pManagement)
