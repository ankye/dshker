import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { assertAccountId } from './account-records'
import { PeerCatalog } from './catalog'
import { assertStateProgress, parseHelperState, type PeerHelperState } from './helper-state'
import { PeerRuntimeOwner } from './runtime-owner'
import type { PeerMainHandler, PeerRpc } from './rpc'
import { PeerSupervisor } from './supervisor'
import { exactPeerObject, PeerHelperError } from './wire'

interface Options {
  resourcesRoot: string
  catalog: PeerCatalog
  runtime: Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>
  onUnavailable?(): void
}

/** Main composition owner. No process is started until an explicit P2P operation. */
export class PeerRuntimeHost {
  readonly #runtime: PeerRuntimeOwner
  readonly #lifetime = new AbortController()
  readonly #runtimeServices = new Set<string>()
  readonly #states = new Map<string, { serviceId: string; state: PeerHelperState }>()
  #supervisor: PeerSupervisor | undefined
  #starting: Promise<PeerRpc> | undefined
  #closing: Promise<void> | undefined
  #failure: PeerHelperError | undefined

  constructor(private readonly options: Options) {
    this.#runtime = new PeerRuntimeOwner(options.runtime, (generation) => {
      void this.#invalidate(generation).catch(() => {
        this.#unavailable(new PeerHelperError('p2p.runtime_invalidation_failed'))
      })
    })
  }

  /** Private main RPC only; never register this method directly as renderer IPC. */
  async start(signal: AbortSignal): Promise<PeerRpc> {
    this.#admit(signal)
    if (!(await this.options.catalog.inspect())) throw new PeerHelperError('p2p.not_enabled')
    this.#admit(signal)
    if (this.#supervisor) return this.#supervisor.rpc
    // One owner starts the helper. Another command must retry explicitly once ready.
    if (this.#starting) throw new PeerHelperError('p2p.helper_busy')
    this.#starting = this.#spawn(signal)
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  snapshot(): { error: string; peers: { serviceId: string; state: PeerHelperState }[] } {
    return {
      error: this.#failure?.code ?? '',
      peers: [...this.#states.values()].map(({ serviceId, state }) => ({
        serviceId,
        state: { ...state, path: { ...state.path } }
      }))
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#stop()
    return this.#closing
  }

  async failClosed(error: PeerHelperError): Promise<void> {
    this.#unavailable(error)
    await this.close()
  }

  async #spawn(signal: AbortSignal): Promise<PeerRpc> {
    const budget = AbortSignal.any([signal, this.#lifetime.signal])
    try {
      const supervisor = await PeerSupervisor.start(
        {
          resourcesRoot: this.options.resourcesRoot,
          handler: this.#handle,
          onUnavailable: (error) => this.#unavailable(error)
        },
        budget
      )
      this.#supervisor = supervisor
      this.#admit(budget)
      return supervisor.rpc
    } catch (error) {
      this.#unavailable(
        error instanceof PeerHelperError ? error : new PeerHelperError('p2p.helper_unavailable')
      )
      await this.#supervisor?.close()
      throw error
    }
  }

  readonly #handle: PeerMainHandler = async (method, payload, signal) => {
    this.#admit(signal)
    const fields = exactPeerObject(
      payload,
      method === 'runtime.connect' ? ['serviceId', 'pairId'] : ['serviceId', 'state']
    )
    assertAccountId(fields.serviceId, 64)
    const state = method === 'peer.state' ? parseHelperState(fields.state) : undefined
    const pairId = state ? state.pairId : fields.pairId
    assertAccountId(pairId)
    await this.#authorize(fields.serviceId, pairId)
    this.#admit(signal)
    const key = `${fields.serviceId}:${pairId}`
    if (state) {
      const previous = this.#states.get(key)
      if (previous) assertStateProgress(previous.state, state)
      this.#states.set(key, { serviceId: fields.serviceId, state })
      return {}
    }
    const current = this.#states.get(key)?.state
    if (!current || current.stage !== 'starting-runtime')
      throw new PeerHelperError('p2p.runtime_request_unscoped')
    this.#runtimeServices.add(fields.serviceId)
    const binding = await this.#runtime.connect(signal)
    await this.#authorize(fields.serviceId, pairId)
    this.#admit(signal)
    if (this.#states.get(key)?.state !== current) throw new PeerHelperError('p2p.stale_generation')
    this.#runtime.assertCurrent(binding)
    return binding
  }

  async #authorize(serviceId: string, pairId: string): Promise<void> {
    const saved = await this.options.catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const { record } = saved
    if (record.forgottenServiceIds.includes(serviceId))
      throw new PeerHelperError('p2p.trust_restore_rejected')
    if (
      !record.services.some((service) => service.serviceId === serviceId) ||
      !record.computers.some(
        (computer) =>
          computer.serviceId === serviceId &&
          computer.pairId === pairId &&
          computer.pairState === 'active'
      )
    )
      throw new PeerHelperError('p2p.pair_unauthorized')
  }

  async #invalidate(generation: number): Promise<void> {
    if (this.#lifetime.signal.aborted || !this.#supervisor) return
    // The set contains only managers that actually requested this local runtime.
    // Outgoing peers on other services never receive a local-runtime invalidation.
    await Promise.all(
      [...this.#runtimeServices].map(async (serviceId) => {
        exactPeerObject(
          await this.#supervisor!.rpc.call(
            'runtime.invalidate',
            {
              serviceId,
              data: { generation }
            },
            this.#lifetime.signal
          ),
          []
        )
      })
    )
  }

  #unavailable(error: PeerHelperError): void {
    if (this.#lifetime.signal.aborted) return
    this.#failure ??= error
    this.#lifetime.abort()
    this.#runtime.close()
    for (const value of this.#states.values()) {
      value.state = { ...value.state, stage: 'failed', error: this.#failure.code }
    }
    this.options.onUnavailable?.()
    // Close the actual child as well as RPC. This is failure containment, not a retry.
    void this.#supervisor?.close().catch(() => {
      this.#failure = new PeerHelperError('p2p.helper_cleanup_failed')
    })
  }

  async #stop(): Promise<void> {
    this.#lifetime.abort()
    this.#runtime.close()
    try {
      await this.#starting
    } catch {
      // The initiating call reports the startup failure; shutdown still owns cleanup.
    }
    await this.#supervisor?.close()
    this.#runtimeServices.clear()
    this.#states.clear()
  }

  #admit(signal: AbortSignal): void {
    if (this.#failure) throw this.#failure
    if (this.#lifetime.signal.aborted) throw new PeerHelperError('p2p.helper_closed')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
  }
}
