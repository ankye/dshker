import { reactive } from 'vue'
import { p2pRefusalKind } from '@/shared/p2p-refusal'
import type {
  P2PDirectoryView,
  P2PNetworkDeviceView,
  P2PNetworkView,
  P2PUserView
} from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain, type P2PDomainResult } from './p2pManagement'

export interface P2PAccountState {
  user: P2PUserView | null | undefined
  sessionStatus: P2PAccountSessionStatus
  networks: P2PNetworkView[] | undefined
  /** Last network-list read failure; existing rows remain usable when present. */
  networksError: string | undefined
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

export type P2PAccountSessionStatus = 'unknown' | 'restoring' | 'signedIn' | 'signedOut'

/** Account state is partitioned by the pinned service identity, never by its name. */
export class P2PAccountsDomain {
  readonly #states = reactive<Record<string, P2PAccountState>>({})
  /** Startup and the mounted account panel share one current-user read. */
  readonly #currentUserInFlight = new Map<string, { revision: number; pending: Promise<void> }>()
  readonly #sessionRevisions = new Map<string, number>()
  /** An announcement during a read requires one fresh read after that one settles. */
  readonly #readAfterCurrent = new Set<string>()
  #unsubscribe: (() => void) | undefined
  #sessionUnsubscribe: (() => void) | undefined
  /** A login-required reply during startup is provisional until service restore runs. */
  readonly #retryAfterSession = new Set<string>()
  /** Explicit logout is the only state that must not be reopened by a session event. */
  readonly #explicitSignOut = new Set<string>()
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): P2PAccountState {
    if (!this.#states[serviceId])
      this.#states[serviceId] = {
        user: undefined,
        sessionStatus: 'unknown',
        networks: undefined,
        networksError: undefined,
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

  /** The selected account's confirmed login state, independent of device transport. */
  sessionStatus(serviceId: string): P2PAccountSessionStatus {
    return this.state(serviceId).sessionStatus
  }

  /**
   * Establishes the account and its device directory once, independent of any
   * route.
   *
   * A machine that is already signed in has its networks and their devices the
   * moment the app opens. Reading them only when the account pane mounted — or
   * when someone pressed refresh — made the list a property of where the read
   * lived rather than of the account, which is exactly what a first launch looked
   * like when the answer was already known. Subscribing first means a change the
   * core announces while nobody is looking is still applied.
   *
   * Idempotent: provisioning returns early once done, and reads queue per scope,
   * so a panel that also reads on entry costs one extra read rather than
   * colliding.
   */
  async start(): Promise<void> {
    this.subscribe()
    await this.management.ensureBuiltinService()
    const serviceId = this.management.selectedServiceId.value
    if (serviceId === undefined) return
    await this.currentUser(serviceId)
    await this.readDirectory(serviceId)
  }

  currentUser(serviceId: string): Promise<void> {
    const revision = this.#revision(serviceId)
    const previous = this.#currentUserInFlight.get(serviceId)
    if (previous?.revision === revision) return previous.pending
    const pending = this.#readCurrentUser(serviceId, revision)
    const entry = { revision, pending }
    this.#currentUserInFlight.set(serviceId, entry)
    return pending.finally(() => {
      if (this.#currentUserInFlight.get(serviceId) !== entry) return
      this.#currentUserInFlight.delete(serviceId)
      if (this.#readAfterCurrent.delete(serviceId) && !this.#explicitSignOut.has(serviceId))
        void this.currentUser(serviceId)
    })
  }

  async #readCurrentUser(serviceId: string, revision: number): Promise<void> {
    const state = this.state(serviceId)
    const wasSignedIn = state.sessionStatus === 'signedIn'
    if (state.sessionStatus !== 'signedIn') state.sessionStatus = 'restoring'
    let result: P2PDomainResult<'currentUser'>
    try {
      result = await this.management.runRead('currentUser', { serviceId })
    } finally {
      if (this.#revision(serviceId) === revision && state.sessionStatus === 'restoring')
        state.sessionStatus = 'unknown'
    }
    if (this.#revision(serviceId) !== revision) return
    if (result.ok) {
      if (state.user && state.user.userId !== result.data.userId)
        this.#advanceSessionRevision(serviceId)
      this.#retryAfterSession.delete(serviceId)
      this.#explicitSignOut.delete(serviceId)
      this.#acceptUser(state, result.data)
      return this.#readNetworksForSession(serviceId)
    }
    // Any refusal that means "no session" clears authority, not just the three
    // codes this used to name. A hard-coded list left every other refusal in a
    // half state: the user was neither accepted nor cleared, so the panel showed
    // the password form again while still believing a read was in progress.
    if (p2pRefusalKind(result.code) === 'signedOut') {
      this.#advanceSessionRevision(serviceId)
      this.#signedOut(state)
      if (this.#explicitSignOut.has(serviceId)) this.#retryAfterSession.delete(serviceId)
      else this.#retryAfterSession.add(serviceId)
    } else {
      // Refresh failure cannot revoke this revision's confirmed login. An
      // initial or unknown read still has no login evidence, even if it retains
      // a historical user. Revision and signed-out checks above fence both.
      this.#retryAfterSession.add(serviceId)
      state.sessionStatus = wasSignedIn ? 'signedIn' : 'unknown'
    }
  }

  async login(serviceId: string, username: string, password: string): Promise<void> {
    if (this.management.busy(serviceId)) return
    const result = await this.management.run('login', { serviceId, username, password })
    if (!result.ok) return
    this.#invalidateSessionRead(serviceId)
    this.#explicitSignOut.delete(serviceId)
    this.#retryAfterSession.delete(serviceId)
    this.#acceptUser(this.state(serviceId), result.data)
    // Authentication is authoritative as soon as the main process has persisted
    // and published the session. Re-read that confirmed session asynchronously:
    // the core uses this authenticated read to adopt existing network membership
    // and notify online peers, while the panel shows the signed-in identity
    // immediately and owns any later network-list error state.
    void this.currentUser(serviceId)
  }

  /**
   * Creates an account on the coordinator with an email identity.
   *
   * A confirmed registration returns the same user projection as a login, so
   * the panel transitions to the signed-in view exactly like a successful
   * sign-in. The server refuses a duplicate email (p2p.user_conflict).
   */
  async register(serviceId: string, email: string, password: string): Promise<void> {
    if (this.management.busy(serviceId)) return
    const result = await this.management.run('register', { serviceId, email, password })
    if (!result.ok) return
    this.#invalidateSessionRead(serviceId)
    this.#explicitSignOut.delete(serviceId)
    this.#retryAfterSession.delete(serviceId)
    this.#acceptUser(this.state(serviceId), result.data)
    void this.currentUser(serviceId)
  }

  async logout(serviceId: string): Promise<void> {
    if (this.management.busy(serviceId)) return
    const wasExplicitSignOut = this.#explicitSignOut.has(serviceId)
    this.#invalidateSessionRead(serviceId)
    this.#explicitSignOut.add(serviceId)
    this.#retryAfterSession.delete(serviceId)
    const result = await this.management.run('logout', { serviceId })
    if (!result.ok && result.code === 'p2p.service_busy') {
      if (!wasExplicitSignOut) this.#explicitSignOut.delete(serviceId)
      if (this.state(serviceId).sessionStatus === 'restoring')
        this.state(serviceId).sessionStatus = 'unknown'
      return
    }
    // Main discards local login authority before attempting server revocation.
    // A lost response is unknown; do not keep displaying usable account authority.
    if (result.ok || p2pRefusalKind(result.code) === 'signedOut')
      this.#signedOut(this.state(serviceId))
    else if (result.code !== 'p2p.service_busy') {
      this.#signedOut(this.state(serviceId))
      this.state(serviceId).user = undefined
      this.state(serviceId).sessionStatus = 'unknown'
    }
  }

  async networks(serviceId: string): Promise<void> {
    const revision = this.#revision(serviceId)
    const result = await this.management.runRead('networks', { serviceId })
    if (this.#revision(serviceId) !== revision) return
    const state = this.state(serviceId)
    if (!result.ok) {
      // A sibling read already owns the helper channel. It is not a failed
      // network list, and the existing operation status already communicates
      // that the panel is waiting for the read path to settle.
      if (result.code === 'p2p.service_busy' || result.code === 'p2p.helper_busy') return
      // Keep a last known list visible, but make the failed refresh actionable.
      // An undefined list remains an explicit loading/failed state rather than
      // being mistaken for an empty account.
      state.networksError = result.code
      return
    }
    state.networksError = undefined
    state.networks = result.data
    state.networkWriteUnconfirmed = false
    if (!result.data.some((network) => network.networkId === state.selectedNetworkId))
      state.selectedNetworkId = undefined
    // A single owned network is not a choice, so asking for a click is friction
    // with no decision behind it. Several networks stay unselected: choosing one
    // there would be a guess about where the next edit or delete lands.
    if (state.selectedNetworkId !== undefined) return
    // The owner's own earlier choice comes first, but only for the account that
    // made it and only while that network is still there. Failing that, a single
    // network needs no choice at all. Several unknown networks stay unselected:
    // picking one would be a guess about where the next edit lands.
    const userId = state.user?.userId
    if (userId !== undefined) {
      const remembered = await this.management.runRead('accountSelection', { serviceId, userId })
      if (this.#revision(serviceId) !== revision) return
      const preferred = remembered.ok ? remembered.data.networkId : null
      if (preferred !== null && result.data.some((item) => item.networkId === preferred)) {
        state.selectedNetworkId = preferred
        return
      }
    }
    if (result.data.length === 1) state.selectedNetworkId = result.data[0].networkId
  }

  /**
   * Projects the core's whole directory into this domain's per-network state.
   *
   * The coordinator's directory has one owner in the application — the core — and
   * one snapshot per service. This is a view of it, not another copy: every
   * network the account owns and the account's own devices are filled from the
   * same answer, so a list that is correct on one page cannot be stale on
   * another.
   */
  async readDirectory(serviceId: string): Promise<void> {
    this.subscribe()
    const revision = this.#revision(serviceId)
    const result = await this.management.runRead('directory', { serviceId })
    if (this.#revision(serviceId) !== revision) return
    if (!result.ok) {
      // A directory that could not be read keeps what was last projected: the
      // failure belongs to the page that asked, not to every row on it.
      const failed = this.state(serviceId)
      for (const networkId of Object.keys(failed.devices)) failed.devicesFailed[networkId] = true
      return
    }
    this.#acceptDirectory(serviceId, result.data)
  }

  /**
   * Asks the core to read the coordinator again, then projects the result.
   *
   * The core maintains the directory on its own; this is the explicit "now"
   * behind the refresh control, and the only path that makes a page ask the
   * coordinator for anything. A refusal is shown where the list is, not as an
   * account failure: the account card is about the sign-in, not about one read.
   */
  async refreshDirectory(serviceId: string): Promise<void> {
    this.subscribe()
    const revision = this.#revision(serviceId)
    const result = await this.management.run('refreshDirectory', { serviceId })
    if (this.#revision(serviceId) !== revision) return
    if (!result.ok) {
      // A read that is already in flight answers this request too, so a busy
      // refusal is not a failure: reporting it would put a warning over a list
      // that is being refreshed right now. p2p.helper_busy is the channel saying
      // the same thing, one layer down.
      if (result.code === 'p2p.service_busy' || result.code === 'p2p.helper_busy') return
      const state = this.state(serviceId)
      for (const networkId of Object.keys(state.devices)) state.devicesFailed[networkId] = true
      return
    }
    this.#acceptDirectory(serviceId, result.data)
  }

  #acceptDirectory(serviceId: string, directory: P2PDirectoryView): void {
    const state = this.state(serviceId)
    if (!directory.known) return
    for (const network of directory.networks) {
      state.devices[network.networkId] = [...network.devices]
      state.devicesFailed[network.networkId] = false
    }
    // A network the answer no longer carries was deleted or is no longer this
    // account's: keeping its rows would show devices of a network that is gone.
    const known = new Set(directory.networks.map((network) => network.networkId))
    for (const networkId of Object.keys(state.devices))
      if (!known.has(networkId)) delete state.devices[networkId]
  }

  /**
   * Follows the directory changes the core announces.
   *
   * Subscribing is what makes a list current without anyone clicking: the core
   * reads at startup, after a membership change and on its own interval, and
   * announces only real changes. Polling would also arrive eventually, but only
   * after showing the wrong answer for a while — which is exactly how two machines
   * ended up disagreeing about who was in the same network.
   */
  subscribe(): void {
    const api = window.dshLauncher?.p2pManagement
    if (api === undefined) return
    if (this.#unsubscribe === undefined && api.onDirectoryChange !== undefined)
      this.#unsubscribe = api.onDirectoryChange((event) => void this.readDirectory(event.serviceId))
    if (this.#sessionUnsubscribe === undefined && api.onServiceSessionsChange !== undefined) {
      this.#sessionUnsubscribe = api.onServiceSessionsChange(() => {
        const serviceId = this.management.selectedServiceId.value
        if (serviceId === undefined) return
        if (this.#explicitSignOut.has(serviceId)) return
        // The main process establishes coordinator/device sessions after the
        // window exists. A first account read can therefore finish before that
        // restore. A login-required reply from that window is provisional; an
        // explicit user logout is the only state that must stay signed out.
        const state = this.state(serviceId)
        if (state.user !== null || this.#retryAfterSession.has(serviceId)) {
          if (this.#currentUserInFlight.has(serviceId)) this.#readAfterCurrent.add(serviceId)
          else void this.currentUser(serviceId)
        }
      })
    }
  }

  /** Releases the subscription; used by tests and any future shell teardown. */
  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#sessionUnsubscribe?.()
    this.#sessionUnsubscribe = undefined
    this.#currentUserInFlight.clear()
    for (const serviceId of Object.keys(this.#states)) {
      this.#invalidateSessionRead(serviceId)
      if (this.state(serviceId).sessionStatus === 'restoring')
        this.state(serviceId).sessionStatus = 'unknown'
    }
    this.#readAfterCurrent.clear()
    this.#retryAfterSession.clear()
    this.#explicitSignOut.clear()
  }

  /**
   * Removes one device from a network and reads the directory again.
   *
   * The coordinator owns the binding, so the list is re-read rather than edited
   * locally: what the owner sees afterwards is what the server still holds. The
   * read is the core's, and it is asked for explicitly because the removal just
   * changed the answer.
   */
  async removeDevice(serviceId: string, networkId: string, deviceId: string): Promise<boolean> {
    const result = await this.management.run('leaveNetwork', { serviceId, networkId, deviceId })
    if (!result.ok) return false
    await this.refreshDirectory(serviceId)
    return true
  }

  async select(serviceId: string, networkId: string): Promise<void> {
    const state = this.state(serviceId)
    if (
      this.management.busy(serviceId) ||
      !state.networks?.some((network) => network.networkId === networkId)
    )
      return
    state.selectedNetworkId = networkId
    // Only an explicit choice is remembered: this machine must never store its own
    // default as though the owner had asked for it.
    const userId = state.user?.userId
    if (userId !== undefined)
      await this.management.run('rememberAccountSelection', { serviceId, userId, networkId })
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
   * Login and registration deliberately start this read without awaiting it:
   * authentication has already settled, and the panel owns the list's loading
   * and retry feedback. A failure leaves the list undefined (or preserves an
   * existing list) and records a typed error for that region rather than
   * reopening the credential form.
   */
  async #readNetworksForSession(serviceId: string): Promise<void> {
    if (this.state(serviceId).networks !== undefined) return
    await this.networks(serviceId)
  }
  #acceptUser(state: P2PAccountState, user: P2PUserView): void {
    if (state.user && state.user.userId !== user.userId) {
      state.devices = {}
      state.devicesFailed = {}
    }
    if (state.user?.userId !== user.userId) {
      state.networks = undefined
      state.networksError = undefined
      state.selectedNetworkId = undefined
      state.renameDrafts = {}
      state.networkWriteUnconfirmed = false
    }
    state.user = user
    state.sessionStatus = 'signedIn'
  }
  #signedOut(state: P2PAccountState): void {
    state.user = null
    state.sessionStatus = 'signedOut'
    state.networks = undefined
    state.networksError = undefined
    state.selectedNetworkId = undefined
    state.renameDrafts = {}
    state.networkWriteUnconfirmed = false
    state.devices = {}
    state.devicesFailed = {}
  }

  #revision(serviceId: string): number {
    return this.#sessionRevisions.get(serviceId) ?? 0
  }

  #invalidateSessionRead(serviceId: string): void {
    this.#advanceSessionRevision(serviceId)
    this.#readAfterCurrent.delete(serviceId)
  }

  #advanceSessionRevision(serviceId: string): void {
    this.#sessionRevisions.set(serviceId, this.#revision(serviceId) + 1)
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
