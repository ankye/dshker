import { reactive, readonly, ref } from 'vue'
import type { ApiResult } from '@/shared/contracts'
import {
  P2P_MANAGEMENT_VERSION,
  type P2PManagementApi,
  type P2PManagementInputs,
  type P2PManagementOperation,
  type P2PManagementRequest,
  type P2PManagementResults,
  type P2PManagementErrorCode,
  type P2PCatalogView,
  type P2PServiceInput
} from '@/shared/p2p-management'

type Operation = Exclude<P2PManagementOperation, 'cancel'>
type Failure = P2PManagementErrorCode | 'bridge' | 'unconfirmed'
export type P2PDomainResult<K extends Operation> = ApiResult<P2PManagementResults[K], Failure>
export interface P2POperationState {
  requestId: number
  method: Operation
  phase: 'pending' | 'cancelling' | 'succeeded' | 'failed'
  error?: Failure
  cancelError?: Failure
}

// One sequence for the whole document, never reset by component mount or service changes.
let sequence = 0
function nextRequestId(): number {
  if (sequence === Number.MAX_SAFE_INTEGER) throw new Error('p2p.request_limit')
  return ++sequence
}
const reads = new Set<Operation>(['catalog', 'currentUser', 'networks', 'registration'])

/** Domain owner survives route changes. No password, token or request body enters state. */
export class P2PManagementDomain {
  readonly #operations = reactive<Record<string, P2POperationState>>({})
  readonly operations = readonly(this.#operations)
  readonly catalog = ref<P2PCatalogView | null>()
  readonly selectedServiceId = ref<string>()
  readonly serviceDraft = reactive<P2PServiceInput>({
    displayName: '',
    httpsOrigin: '',
    wssUrl: '',
    stunAddress: ''
  })

  constructor(private readonly bridge: () => P2PManagementApi | undefined) {}

  busy(scope: string): boolean {
    const state = this.#operations[scope]
    return state?.phase === 'pending' || state?.phase === 'cancelling'
  }

  async run<K extends Operation>(
    method: K,
    input: P2PManagementInputs[K]
  ): Promise<P2PDomainResult<K>> {
    // These contracts contain primitives only. Preserve exactly what was submitted.
    const fields = { ...input }
    const scope = 'serviceId' in fields ? String(fields.serviceId) : 'catalog'
    if (this.busy(scope))
      return { ok: false, code: 'p2p.service_busy', message: 'p2p.service_busy' }
    const requestId = nextRequestId()
    const state: P2POperationState = { requestId, method, phase: 'pending' }
    this.#operations[scope] = state
    const api = this.bridge()
    if (!api || typeof api[method] !== 'function') return this.#fail(scope, requestId, 'bridge')
    try {
      const request = {
        ...fields,
        version: P2P_MANAGEMENT_VERSION,
        requestId
      } as P2PManagementRequest<K>
      const invoke = api[method] as (
        request: P2PManagementRequest<K>
      ) => Promise<P2PDomainResult<K>>
      const result = await invoke(request)
      if (this.#operations[scope]?.requestId !== requestId)
        return { ok: false, code: 'unconfirmed', message: 'unconfirmed' }
      this.#operations[scope] = result.ok
        ? { requestId, method, phase: 'succeeded' }
        : { requestId, method, phase: 'failed', error: result.code }
      return result
    } catch {
      return this.#fail(scope, requestId, reads.has(method) ? 'bridge' : 'unconfirmed')
    }
  }

  async cancel(scope: string): Promise<void> {
    const state = this.#operations[scope]
    if (!state || state.phase !== 'pending') return
    const api = this.bridge()
    if (!api || typeof api.cancel !== 'function') {
      state.cancelError = 'bridge'
      return
    }
    const targetRequestId = state.requestId
    state.phase = 'cancelling'
    try {
      const result = await api.cancel({
        version: P2P_MANAGEMENT_VERSION,
        requestId: nextRequestId(),
        targetRequestId
      })
      // The original operation may already have settled while cancel was in transit.
      const current = this.#operations[scope]
      if (current?.requestId !== targetRequestId || current.phase !== 'cancelling') return
      if (!result.ok) {
        current.phase = 'pending'
        current.cancelError = result.code
      }
    } catch {
      const current = this.#operations[scope]
      if (current?.requestId === targetRequestId && current.phase === 'cancelling') {
        current.phase = 'pending'
        current.cancelError = 'bridge'
      }
    }
  }

  async readCatalog(): Promise<void> {
    const result = await this.run('catalog', {})
    if (result.ok) this.catalog.value = result.data
  }

  async enable(): Promise<void> {
    const result = await this.run('enable', {})
    if (result.ok) this.catalog.value = result.data
  }

  async addService(): Promise<void> {
    const saved = this.catalog.value
    if (!saved || this.busy('catalog')) return
    const submitted = { ...this.serviceDraft }
    const result = await this.run('addService', { ...submitted, revision: saved.revision })
    if (!result.ok) return
    this.catalog.value = result.data
    // Do not erase edits made while the original save was in flight.
    for (const key of Object.keys(submitted) as (keyof P2PServiceInput)[]) {
      if (this.serviceDraft[key] === submitted[key]) this.serviceDraft[key] = ''
    }
  }

  #fail<K extends Operation>(scope: string, requestId: number, code: Failure): P2PDomainResult<K> {
    const current = this.#operations[scope]
    if (current?.requestId === requestId)
      this.#operations[scope] = { ...current, phase: 'failed', error: code }
    return { ok: false, code, message: code }
  }
}

export const p2pManagement = new P2PManagementDomain(() => window.dshLauncher?.p2pManagement)
