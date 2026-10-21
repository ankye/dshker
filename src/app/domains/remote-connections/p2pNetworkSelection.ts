import { reactive } from 'vue'
import type { P2PNetworkChoicesView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface NetworkSelectionState {
  view: P2PNetworkChoicesView | undefined
  loading: boolean
  readFailed: boolean
  pending: string
  unconfirmed: boolean
  error: string
}

/** No automatic network choice, mutation replay, or second connection identity. */
export class P2PNetworkSelectionDomain {
  readonly #states = reactive<Record<string, NetworkSelectionState>>({})
  readonly #epochs = new Map<string, number>()
  #unsubscribe: (() => void) | undefined
  #serviceId: string | undefined
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): NetworkSelectionState {
    return (this.#states[serviceId] ??= {
      view: undefined,
      loading: false,
      readFailed: false,
      pending: '',
      unconfirmed: false,
      error: ''
    })
  }

  /** A different login cannot inherit this service's previous actor's choices. */
  invalidate(serviceId: string): void {
    this.#epochs.set(serviceId, (this.#epochs.get(serviceId) ?? 0) + 1)
    Object.assign(this.state(serviceId), {
      view: undefined,
      loading: false,
      readFailed: false,
      pending: '',
      unconfirmed: false,
      error: ''
    })
  }

  /** Re-reads network choices when the core invalidates a signed-in catalog. */
  subscribe(serviceId: string): void {
    this.#serviceId = serviceId
    if (this.#unsubscribe !== undefined) return
    const api = window.dshLauncher?.p2pManagement
    if (api?.onCatalogChange === undefined) return
    this.#unsubscribe = api.onCatalogChange((event) => {
      if (event.serviceId === this.#serviceId) void this.read(event.serviceId)
    })
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  async read(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    const epoch = (this.#epochs.get(serviceId) ?? 0) + 1
    this.#epochs.set(serviceId, epoch)
    state.loading = true
    const result = await this.management.runRead('networkChoices', { serviceId })
    if (this.#epochs.get(serviceId) !== epoch) return
    state.loading = false
    state.pending = ''
    if (result.ok) {
      state.view = result.data
      state.readFailed = false
      state.unconfirmed = false
      state.error = ''
      await this.management.readCatalog()
    } else {
      state.readFailed = true
      state.error = result.code
    }
  }

  async select(serviceId: string, pairId: string, networkId: string): Promise<boolean> {
    const state = this.state(serviceId)
    const view = state.view
    const device = view?.devices.find((value) => value.pairId === pairId)
    if (
      !view ||
      !device ||
      state.loading ||
      state.readFailed ||
      state.pending ||
      state.unconfirmed ||
      !device.choices.some((choice) => choice.networkId === networkId)
    )
      return false
    const epoch = (this.#epochs.get(serviceId) ?? 0) + 1
    this.#epochs.set(serviceId, epoch)
    state.pending = pairId
    state.error = ''
    const result = await this.management.run('selectNetwork', {
      serviceId,
      pairId,
      networkId,
      userId: view.userId,
      expectedRevision: view.catalogRevision
    })
    if (this.#epochs.get(serviceId) !== epoch) return false
    state.pending = ''
    if (result.ok) {
      state.view = result.data
      state.unconfirmed = false
      await this.management.readCatalog()
      return this.#epochs.get(serviceId) === epoch
    }
    state.error = result.code
    const refused = new Set([
      'p2p.invalid_request',
      'p2p.service_busy',
      'p2p.user_login_required',
      'p2p.user_scope_mismatch',
      'p2p.catalog_conflict',
      'p2p.network_selection_required',
      'p2p.network_selection_stale',
      'p2p.network_selection_conflict',
      'p2p.pair_unauthorized'
    ])
    state.unconfirmed = !refused.has(result.code)
    return false
  }
}

export const p2pNetworkSelection = new P2PNetworkSelectionDomain(p2pManagement)
