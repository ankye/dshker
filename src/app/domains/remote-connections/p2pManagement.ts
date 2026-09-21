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
// Keep the counter on the renderer global as well: Vite HMR re-evaluates this
// module without replacing the WebContents, while the main-process replay guard
// quite correctly keeps the same request scope. Resetting to 1 after HMR makes a
// healthy catalog read look like p2p.request_replayed.
const sequenceHost = globalThis as typeof globalThis & {
  __dshkerP2PRequestSequence?: number
}
function nextRequestId(): number {
  // A renderer that was already hot-reloaded before this counter existed may
  // have consumed low ids in the main-process replay window. Start a fresh
  // document at a time-based high range once, then keep it monotonic on HMR.
  const current = Math.max(sequenceHost.__dshkerP2PRequestSequence ?? 0, Date.now() * 1000)
  if (current === Number.MAX_SAFE_INTEGER) throw new Error('p2p.request_limit')
  const next = current + 1
  sequenceHost.__dshkerP2PRequestSequence = next
  return next
}
const reads = new Set<Operation>([
  'catalog',
  'currentUser',
  'networks',
  'directory',
  'registration'
])

/**
 * Operations that describe this machine as a whole rather than one service.
 *
 * They carry no `serviceId`, so the default scope would put them in the catalog's
 * slot — and they mount beside the catalog card, where a success would erase the
 * catalog's own failure. Each therefore owns its scope.
 */
const MACHINE_SCOPED = new Set<Operation>(['localDevice', 'connections', 'serviceSessions'])

/**
 * How many of the document's P2P calls may be in flight at once.
 *
 * The private channel admits sixteen concurrent calls and refuses the rest with
 * p2p.helper_busy — a contract the core pins with a stress test, not a fault. The
 * shell also has its own traffic (runtime, remote, managed) on the same channel,
 * so the P2P layer keeps well below the limit rather than using it up.
 */
const MAX_CONCURRENT_CALLS = 6

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
  /**
   * Calls in flight, and the callers waiting for a slot.
   *
   * Several panels mount at once and each reads on entry, on top of the reads the
   * shell makes at startup. Without a gate that burst can exceed the channel's
   * sixteen concurrent calls and the refusal lands on whichever feature happened to
   * lose the race — which is how a device list that had already been fetched came
   * to be reported as unreadable, with the failure naming no cause the user could
   * act on.
   */
  #inFlight = 0
  readonly #waiting: (() => void)[] = []
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
  #ensuringBuiltin: Promise<void> | undefined

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

  /**
   * Mirrors the scope `run` derives, so a queued read waits on the right one.
   *
   * Most operations are scoped by the service they act on. The machine-wide ones
   * own their own slot because they mount beside the catalog card and would
   * otherwise erase its failure. The directory owns one too, for the same reason
   * in the other direction: being unable to read the device list is a fact about
   * the list, and it must not paint the account card red.
   */
  #scopeOf<K extends Operation>(method: K, input: P2PManagementInputs[K]): string {
    const fields = { ...input }
    if (MACHINE_SCOPED.has(method)) return method
    const service = 'serviceId' in fields ? String(fields.serviceId) : 'catalog'
    if (method === 'directory' || method === 'refreshDirectory') return `directory:${service}`
    return service
  }

  /** True while this service's directory read or refresh is in flight. */
  directoryBusy(serviceId: string): boolean {
    return this.busy(`directory:${serviceId}`)
  }

  async run<K extends Operation>(
    method: K,
    input: P2PManagementInputs[K]
  ): Promise<P2PDomainResult<K>> {
    // These contracts contain primitives only. Preserve exactly what was submitted.
    const fields = { ...input }
    const scope = this.#scopeOf(method, input)
    if (this.busy(scope))
      return { ok: false, code: 'p2p.service_busy', message: 'p2p.service_busy' }
    const requestId = nextRequestId()
    const state: P2POperationState = { requestId, method, phase: 'pending' }
    this.#operations[scope] = state
    const api = this.bridge()
    if (!api || typeof api[method] !== 'function') return this.#fail(scope, requestId, 'bridge')
    const release = this.#inFlight < MAX_CONCURRENT_CALLS ? this.#takeSlot() : await this.#admit()
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
    } finally {
      release()
    }
  }

  /**
   * Takes a slot without waiting.
   *
   * A call that fits is dispatched in the same turn it was made: the scope's lock
   * is taken synchronously, which is what makes a duplicate submission refuse
   * rather than queue, and it keeps a read's dispatch where the caller put it.
   */
  #takeSlot(): () => void {
    this.#inFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#inFlight -= 1
      this.#waiting.shift()?.()
    }
  }

  /** Waits for room on the channel, then takes the slot that freed up. */
  #admit(): Promise<() => void> {
    return new Promise((resolve) => this.#waiting.push(() => resolve(this.#takeSlot())))
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

  /**
   * Discards a catalog this build cannot read, then provisions again.
   *
   * The read failure is what the user is looking at, so the fresh catalog is
   * recorded here and the built-in server is provisioned immediately: leaving the
   * page on "nothing read yet" after a successful discard would ask the user to
   * do again what the reset just did. A refusal to discard (the catalog reads
   * cleanly) is left in the operation state for the panel to show.
   */
  async resetCatalog(): Promise<void> {
    const result = await this.run('resetCatalog', {})
    if (!result.ok) return
    this.catalog.value = result.data
    this.builtinProvisioned.value = false
    this.builtinRemoved.value = false
    await this.ensureBuiltinService()
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
    if (this.builtinProvisioned.value || this.builtinRemoved.value) return
    if (this.#ensuringBuiltin) return this.#ensuringBuiltin
    const pending = this.#ensureBuiltinService()
    this.#ensuringBuiltin = pending
    try {
      await pending
    } finally {
      if (this.#ensuringBuiltin === pending) this.#ensuringBuiltin = undefined
    }
  }

  async #ensureBuiltinService(): Promise<void> {
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
  }

  #fail<K extends Operation>(scope: string, requestId: number, code: Failure): P2PDomainResult<K> {
    const current = this.#operations[scope]
    if (current?.requestId === requestId)
      this.#operations[scope] = { ...current, phase: 'failed', error: code }
    return { ok: false, code, message: code }
  }
}

export const p2pManagement = new P2PManagementDomain(() => window.dshLauncher?.p2pManagement)
