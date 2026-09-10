import { reactive } from 'vue'
import { p2pRefusalKind } from '@/shared/p2p-refusal'
import type { P2PNetworkDeviceView, P2PNetworkView, P2PUserView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PAccountState {
  user: P2PUserView | null | undefined
  networks: P2PNetworkView[] | undefined
  selectedNetworkId: string | undefined
  usernameDraft: string
  networkNameDraft: string
  renameDrafts: Record<string, string>
  networkWriteUnconfirmed: boolean
  /**
   * Device directory per network id.
   *
   * `undefined` means "not read yet", which is not the same as an empty network:
   * the UI must not claim a network has no devices before it has looked.
   */
  devices: Record<string, P2PNetworkDeviceView[] | undefined>
  devicesFailed: Record<string, boolean>
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
        networkWriteUnconfirmed: false,
        devices: {},
        devicesFailed: {}
      }
    return this.#states[serviceId]
  }

  async currentUser(serviceId: string): Promise<void> {
    const result = await this.management.runRead('currentUser', { serviceId })
    const state = this.state(serviceId)
    if (result.ok) {
      this.#acceptUser(state, result.data)
      return this.#readNetworksForSession(serviceId)
    }
    // Any refusal that means "no session" clears authority, not just the three
    // codes this used to name. A hard-coded list left every other refusal in a
    // half state: the user was neither accepted nor cleared, so the panel showed
    // the password form again while still believing a read was in progress.
    if (p2pRefusalKind(result.code) === 'signedOut') this.#signedOut(state)
  }

  async login(serviceId: string, username: string, password: string): Promise<void> {
    const result = await this.management.run('login', { serviceId, username, password })
    if (!result.ok) return
    this.#acceptUser(this.state(serviceId), result.data)
    await this.#readNetworksForSession(serviceId)
  }

  /**
   * Creates an account on the coordinator with an email identity.
   *
   * A confirmed registration returns the same user projection as a login, so
   * the panel transitions to the signed-in view exactly like a successful
   * sign-in. The server refuses a duplicate email (p2p.user_conflict).
   */
  async register(serviceId: string, email: string, password: string): Promise<void> {
    const result = await this.management.run('register', { serviceId, email, password })
    if (!result.ok) return
    this.#acceptUser(this.state(serviceId), result.data)
    await this.#readNetworksForSession(serviceId)
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
    const result = await this.management.runRead('networks', { serviceId })
    if (!result.ok) return
    const state = this.state(serviceId)
    state.networks = result.data
    state.networkWriteUnconfirmed = false
    if (!result.data.some((network) => network.networkId === state.selectedNetworkId))
      state.selectedNetworkId = undefined
  }

  /** Reads one network's device directory; a failure is surfaced, never silent. */
  async networkDevices(serviceId: string, networkId: string): Promise<void> {
    const result = await this.management.run('networkDevices', { serviceId, networkId })
    const state = this.state(serviceId)
    if (!result.ok) {
      state.devicesFailed[networkId] = true
      return
    }
    state.devices[networkId] = result.data
    state.devicesFailed[networkId] = false
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

  /**
   * Loads the network list for a session the server just confirmed.
   *
   * A read observes state rather than inferring it, so it carries none of the
   * hazard the refusal contract guards against: the app still never retries,
   * resubmits, or claims a status it did not see. Every sibling panel already
   * reads on entry, and requiring a click here left the signed-in card showing
   * "networks are not loaded yet" until the user asked for what the panel exists
   * to display.
   *
   * A failure stays unreported here because the domain leaves the list undefined,
   * which the panel already presents as unread rather than empty.
   */
  async #readNetworksForSession(serviceId: string): Promise<void> {
    if (this.state(serviceId).networks !== undefined) return
    await this.networks(serviceId)
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
        'p2p.network_limit_reached',
        'p2p.user_conflict',
        'p2p.user_login_required',
        'p2p.not_enabled'
      ].includes(code)
    )
      state.networkWriteUnconfirmed = true
  }
}

export const p2pAccounts = new P2PAccountsDomain(p2pManagement)
