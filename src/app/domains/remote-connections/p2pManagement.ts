import { reactive, readonly, ref } from 'vue'
import type { ApiResult } from '@/shared/contracts'
import {
  P2P_BUILTIN_SERVICE,
  P2P_MANAGEMENT_VERSION,
  type P2PManagementApi,
  type P2PManagementInputs,
  type P2PManagementOperation,
  type P2PManagementRequest,
  type P2PManagementResults,
  type P2PManagementErrorCode,
  type P2PCatalogView,
  type P2PLocalDeviceView,
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
const reads = new Set<Operation>([
  'catalog',
  'currentUser',
  'networks',
  'networkDevices',
  'registration'
])

/** Domain owner survives route changes. No password, token or request body enters state. */
export class P2PManagementDomain {
  /**
   * Serializes entry reads that share a busy scope.
   *
   * The signed-in card mounts several panels at once and each reads on entry.
   * Those reads collide in one scope, and `run` refuses a collision with
   * p2p.service_busy, which the read paths treat as "nothing to record" — so a
   * panel silently kept claiming it held no data. Queueing applies to reads
   * only: the refusal still protects writes from duplicate submission, which is
   * what it exists for.
   */
  readonly #readQueues = new Map<string, Promise<unknown>>()
  readonly #operations = reactive<Record<string, P2POperationState>>({})
  readonly operations = readonly(this.#operations)
  readonly catalog = ref<P2PCatalogView | null>()
  readonly localDevice = ref<P2PLocalDeviceView>()
  readonly selectedServiceId = ref<string>()
  /** True once the built-in service is present in the catalog and selected. */
  readonly builtinProvisioned = ref(false)
  /** True when the built-in service was removed and re-adding is refused. */
  readonly builtinRemoved = ref(false)
  readonly serviceDraft = reactive<P2PServiceInput>({
    ...P2P_BUILTIN_SERVICE
  })
  #ensuringBuiltin = false

  constructor(private readonly bridge: () => P2PManagementApi | undefined) {}

  busy(scope: string): boolean {
    const state = this.#operations[scope]
    return state?.phase === 'pending' || state?.phase === 'cancelling'
  }

  /**
   * Runs a read after any read already queued for the same scope has settled.
   *
   * Callers keep using `run` for writes; only entry reads need ordering, and
   * they must not lose their result to a sibling panel's read.
   */
  async runRead<K extends Operation>(
    method: K,
    input: P2PManagementInputs[K]
  ): Promise<P2PDomainResult<K>> {
    const scope = this.#scopeOf(method, input)
    const previous = this.#readQueues.get(scope)
    const attempt = (async () => {
      if (previous) await previous.catch(() => undefined)
      return this.run(method, input)
    })()
    this.#readQueues.set(scope, attempt)
    try {
      return await attempt
    } finally {
      if (this.#readQueues.get(scope) === attempt) this.#readQueues.delete(scope)
    }
  }

  /** Mirrors the scope `run` derives, so a queued read waits on the right one. */
  #scopeOf<K extends Operation>(method: K, input: P2PManagementInputs[K]): string {
    const fields = { ...input }
    if (method === 'localDevice' || method === 'connections') return method
    return 'serviceId' in fields ? String(fields.serviceId) : 'catalog'
  }

  async run<K extends Operation>(
    method: K,
    input: P2PManagementInputs[K]
  ): Promise<P2PDomainResult<K>> {
    // These contracts contain primitives only. Preserve exactly what was submitted.
    const fields = { ...input }
    // Pure machine reads without a service (localDevice, connections) must not
    // collide with the catalog-scoped operations, so they use their own scope.
    const scope =
      method === 'localDevice' || method === 'connections'
        ? method
        : 'serviceId' in fields
          ? String(fields.serviceId)
          : 'catalog'
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

  async readLocalDevice(): Promise<void> {
    const result = await this.run('localDevice', {})
    if (result.ok) this.localDevice.value = result.data
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

  async removeService(serviceId: string): Promise<void> {
    const saved = this.catalog.value
    if (!saved || this.busy(serviceId)) return
    const result = await this.run('removeService', { serviceId })
    if (result.ok) this.catalog.value = result.data
  }

  /**
   * Auto-provisions the built-in coordinator for the simplified P2P flow.
   *
   * Enables P2P when the catalog says it is disabled, adds the built-in
   * service when the catalog has none, and selects it so no user choice is
   * needed. Idempotent: the service is added at most once per document and
   * repeated calls are no-ops. When the built-in was deliberately removed the
   * server refuses re-adding (p2p.trust_restore_rejected); that terminal
   * state is recorded instead of looping. Any other failure — an unavailable
   * bridge, a catalog conflict — leaves the state retryable for the next
   * mount: nothing is marked done unless a readback confirmed it.
   */
  async ensureBuiltinService(): Promise<void> {
    if (this.builtinProvisioned.value || this.builtinRemoved.value || this.#ensuringBuiltin) return
    this.#ensuringBuiltin = true
    try {
      if (this.catalog.value === undefined) await this.readCatalog()
      let saved = this.catalog.value
      if (saved === null) {
        await this.enable()
        saved = this.catalog.value
      }
      if (!saved) return
      const existing = saved.services.find(
        (entry) => entry.httpsOrigin === P2P_BUILTIN_SERVICE.httpsOrigin
      )
      if (existing) {
        this.selectedServiceId.value = existing.serviceId
        this.builtinProvisioned.value = true
        return
      }
      await this.addService()
      const added = this.catalog.value?.services.find(
        (entry) => entry.httpsOrigin === P2P_BUILTIN_SERVICE.httpsOrigin
      )
      if (added) {
        this.selectedServiceId.value = added.serviceId
        this.builtinProvisioned.value = true
        return
      }
      const outcome = this.operations.catalog
      if (outcome?.phase === 'failed' && outcome.error === 'p2p.trust_restore_rejected')
        this.builtinRemoved.value = true
    } finally {
      this.#ensuringBuiltin = false
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
