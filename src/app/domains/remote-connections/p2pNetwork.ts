import { reactive } from 'vue'
import type { P2PServiceSessionView } from '@/shared/p2p-management'
import { p2pConnections, type P2PConnectionsDomain } from './p2pConnections'
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
  #unsubscribe: (() => void) | undefined
  constructor(
    private readonly management: P2PManagementDomain,
    private readonly connections: P2PConnectionsDomain
  ) {}

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

  /**
   * Establishes the shared network facts once, independent of any route.
   *
   * The status bar reports network reach from every route, so the read that
   * fills it cannot depend on the user opening Remote connections first: the
   * shell otherwise showed "unknown" until that tab was visited, which is a
   * property of where the read lived rather than of the network. Provisioning is
   * included because the session is keyed by the selected service, and nothing
   * selects the built-in coordinator until it is provisioned.
   *
   * Idempotent: provisioning already returns early once done, and the read is
   * queued per scope, so a panel that also reads on entry costs one extra read
   * rather than colliding.
   */
  async start(): Promise<void> {
    this.#subscribe()
    await this.management.ensureBuiltinService()
    await this.read()
    // Pair connections drive the runtime tab indicators, which exist on the
    // Browser route regardless of whether Remote connections was ever opened.
    // Their own polling only continues an in-flight attempt, so without a first
    // read here every peer tab reported an unread state forever.
    await this.connections.read()
  }

  /**
   * Follows session changes pushed by main.
   *
   * Startup establishes sessions after the window exists, so the first read can
   * legitimately observe a state that is already stale. Polling would also find
   * the change eventually, but only after showing the wrong answer for a while.
   */
  #subscribe(): void {
    if (this.#unsubscribe !== undefined) return
    const api = window.dshLauncher?.p2pManagement
    if (api?.onServiceSessionsChange === undefined) return
    this.#unsubscribe = api.onServiceSessionsChange(() => void this.read())
  }

  /** Releases the subscription; used by tests and any future shell teardown. */
  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }
}

export const p2pNetwork = new P2PNetworkDomain(p2pManagement, p2pConnections)
