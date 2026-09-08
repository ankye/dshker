import { reactive } from 'vue'
import type { P2PNetworkView, P2PUserView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PAccountState {
  user: P2PUserView | null | undefined
  networks: P2PNetworkView[] | undefined
  selectedNetworkId: string | undefined
  usernameDraft: string
  networkNameDraft: string
  renameDrafts: Record<string, string>
  networkWriteUnconfirmed: boolean
}

/** Account state is partitioned by the pinned service identity, never by its name. */
export class P2PAccountsDomain {
  readonly #states = reactive<Record<string, P2PAccountState>>({})
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): P2PAccountState {
    if (!this.#states[serviceId])
      this.#states[serviceId] = {
        user: undefined,
        networks: undefined,
        selectedNetworkId: undefined,
        usernameDraft: '',
        networkNameDraft: '',
        renameDrafts: {},
        networkWriteUnconfirmed: false
      }
    return this.#states[serviceId]
  }

  async currentUser(serviceId: string): Promise<void> {
    const result = await this.management.run('currentUser', { serviceId })
    const state = this.state(serviceId)
    if (result.ok) this.#acceptUser(state, result.data)
    else if (
      ['p2p.user_login_required', 'p2p.user_session_expired', 'p2p.user_unauthorized'].includes(
        result.code
      )
    )
      this.#signedOut(state)
  }

  async login(serviceId: string, username: string, password: string): Promise<void> {
    const result = await this.management.run('login', { serviceId, username, password })
    if (result.ok) this.#acceptUser(this.state(serviceId), result.data)
  }

  async logout(serviceId: string): Promise<void> {
    if (this.management.busy(serviceId)) return
    const result = await this.management.run('logout', { serviceId })
    // Main discards local login authority before attempting server revocation.
    // A lost response is unknown; do not keep displaying usable account authority.
    if (result.ok) this.#signedOut(this.state(serviceId))
    else if (result.code !== 'p2p.service_busy') {
      this.#signedOut(this.state(serviceId))
      this.state(serviceId).user = undefined
    }
  }

  async networks(serviceId: string): Promise<void> {
    const result = await this.management.run('networks', { serviceId })
    if (!result.ok) return
    const state = this.state(serviceId)
    state.networks = result.data
    state.networkWriteUnconfirmed = false
    if (!result.data.some((network) => network.networkId === state.selectedNetworkId))
      state.selectedNetworkId = undefined
  }

  select(serviceId: string, networkId: string): void {
    const state = this.state(serviceId)
    if (
      this.management.busy(serviceId) ||
      !state.networks?.some((network) => network.networkId === networkId)
    )
      return
    state.selectedNetworkId = networkId
  }

  async createNetwork(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.networkWriteUnconfirmed) return
    const name = state.networkNameDraft
    const result = await this.management.run('createNetwork', { serviceId, name })
    if (!result.ok) {
      this.#networkFailure(state, result.code)
      return
    }
    // A create result is not a complete list. Do not manufacture an empty prior list.
    if (state.networks !== undefined) state.networks = [...state.networks, result.data]
    if (state.networkNameDraft === name) state.networkNameDraft = ''
  }

  async renameNetwork(serviceId: string, networkId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.networkWriteUnconfirmed) return
    const name = state.renameDrafts[networkId]
    if (name === undefined) return
    const result = await this.management.run('renameNetwork', { serviceId, networkId, name })
    if (!result.ok) {
      this.#networkFailure(state, result.code)
      return
    }
    if (state.networks !== undefined)
      state.networks = state.networks.map((network) =>
        network.networkId === networkId ? result.data : network
      )
    if (state.renameDrafts[networkId] === name) delete state.renameDrafts[networkId]
  }

  /**
   * Raises the device capacity of one owned network (10 -> 20/30).
   *
   * The server remains authoritative: it rejects a limit that is not a raise
   * for the signed-in owner with a typed error, and only a confirmed result
   * replaces the listed network view.
   */
  async raiseNetworkLimit(serviceId: string, networkId: string, maxDevices: number): Promise<void> {
    const state = this.state(serviceId)
    if (state.networkWriteUnconfirmed) return
    const current = state.networks?.find((network) => network.networkId === networkId)
    if (!current || current.maxDevices >= maxDevices) return
    const result = await this.management.run('updateNetworkLimit', {
      serviceId,
      networkId,
      maxDevices
    })
    if (!result.ok) {
      this.#networkFailure(state, result.code)
      return
    }
    if (state.networks !== undefined)
      state.networks = state.networks.map((network) =>
        network.networkId === networkId ? result.data : network
      )
  }

  async deleteNetwork(serviceId: string, networkId: string): Promise<boolean> {
    const state = this.state(serviceId)
    if (state.networkWriteUnconfirmed) return false
    const result = await this.management.run('deleteNetwork', { serviceId, networkId })
    if (!result.ok) {
      this.#networkFailure(state, result.code)
      return false
    }
    if (state.networks !== undefined)
      state.networks = state.networks.filter((network) => network.networkId !== networkId)
    if (state.selectedNetworkId === networkId) state.selectedNetworkId = undefined
    delete state.renameDrafts[networkId]
    return true
  }

  #acceptUser(state: P2PAccountState, user: P2PUserView): void {
    if (state.user?.userId !== user.userId) {
      state.networks = undefined
      state.selectedNetworkId = undefined
      state.renameDrafts = {}
      state.networkWriteUnconfirmed = false
    }
    state.user = user
  }
  #signedOut(state: P2PAccountState): void {
    state.user = null
    state.networks = undefined
    state.selectedNetworkId = undefined
    state.renameDrafts = {}
    state.networkWriteUnconfirmed = false
  }

  #networkFailure(state: P2PAccountState, code: string): void {
    // Only these errors prove no write was admitted. Other errors may have
    // happened during cleanup/readback after the server already committed.
    if (
      ![
        'bridge',
        'p2p.service_busy',
        'p2p.invalid_request',
        'p2p.invalid_operation',
        'p2p.invalid_network_limit',
        'p2p.user_login_required',
        'p2p.not_enabled'
      ].includes(code)
    )
      state.networkWriteUnconfirmed = true
  }
}

export const p2pAccounts = new P2PAccountsDomain(p2pManagement)
