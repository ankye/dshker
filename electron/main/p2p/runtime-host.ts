import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { assertAccountId } from './account-records'
import { PeerCatalog } from './catalog'
import { assertStateProgress, parseHelperState, type PeerHelperState } from './helper-state'
import { PeerRuntimeOwner } from './runtime-owner'
import type { PeerMainHandler } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

/**
 * The private channel of the running core, as the peer state machine needs it.
 *
 * The core is the only networking process: it answers the peer methods and calls
 * back for the runtime owner and every connection stage. The channel outlives
 * this host — the catalog and the secret store share it — so a host that stops
 * detaches instead of closing it.
 */
export interface PeerChannel {
  call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown>
  /** Serves the parent-role callbacks; returns the detach function. */
  serve(handler: PeerMainHandler): () => void
  /** Observes the channel's death; returns the detach function. */
  observe(listener: (error: PeerHelperError) => void): () => void
}

interface Options {
  /** The core's channel. A shell that could not start a core has none, and P2P then fails typed. */
  channel?: PeerChannel
  catalog: PeerCatalog
  runtime: Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>
  onUnavailable?(): void
  /**
   * Reports every connection stage the helper announces.
   *
   * A drop is the moment a reconnect has to start: waiting for the next
   * periodic sweep would leave a tab dead for up to a minute for what is often
   * a one second network change.
   */
  onPeerStage?(serviceId: string, pairId: string, stage: string): void
  /**
   * Reports a new revision of the core's directory snapshot for one service.
   *
   * The core owns the snapshot and announces its changes, so this is the only
   * way a device list the renderer already read learns that it moved.
   */
  onDirectoryChange?(serviceId: string): void
  /**
   * Reports a new revision of the core's paired-computer catalog for one service.
   *
   * Same reason as the directory: the core records the coordinator's pairs
   * itself, so a Run menu that already listed the computers learns about a newly
   * paired one only from here. The revision travels with the service because it
   * is the core's own snapshot identity.
   */
  onCatalogChange?(serviceId: string, revision: string): void
}

/** Main composition owner. Nothing is started until an explicit P2P operation. */
export class PeerRuntimeHost {
  readonly #runtime: PeerRuntimeOwner
  readonly #lifetime = new AbortController()
  readonly #runtimeServices = new Set<string>()
  readonly #states = new Map<string, { serviceId: string; state: PeerHelperState }>()
  #detach: (() => void) | undefined
  #pending = false
  #closing: Promise<void> | undefined
  #failure: PeerHelperError | undefined

  constructor(private readonly options: Options) {
    this.#runtime = new PeerRuntimeOwner(options.runtime, (generation) => {
      void this.#invalidate(generation).catch(() => {
        this.#unavailable(new PeerHelperError('p2p.runtime_invalidation_failed'))
      })
    })
  }

  /** Private main channel only; never register this method directly as renderer IPC. */
  async start(signal: AbortSignal): Promise<PeerChannel> {
    this.#admit(signal)
    // The guard is set before the first await: a second caller retries rather
    // than racing the attach.
    if (this.#pending) throw new PeerHelperError('p2p.helper_busy')
    this.#pending = true
    try {
      if (!(await this.options.catalog.inspect())) throw new PeerHelperError('p2p.not_enabled')
      this.#admit(signal)
      const channel = this.options.channel
      // A shell that could not start a core has no transport: P2P is unavailable
      // rather than silently degraded to a second process that no longer exists.
      if (channel === undefined) throw new PeerHelperError('p2p.helper_unavailable')
      this.#attach(channel)
      return channel
    } finally {
      this.#pending = false
    }
  }

  #attach(channel: PeerChannel): void {
    if (this.#detach !== undefined) return
    const stopServing = channel.serve(this.#handle)
    const stopObserving = channel.observe((error) => {
      // The channel is gone, so no callback can arrive again: release the
      // handler instead of leaving the core talking to a dead state machine.
      // A failure that leaves the core alive keeps serving, so the core still
      // gets the recorded reason rather than a bare not-implemented.
      this.#detach?.()
      this.#detach = undefined
      this.#unavailable(error)
    })
    this.#detach = () => {
      stopServing()
      stopObserving()
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

  readonly #handle: PeerMainHandler = async (method, payload, signal) => {
    this.#admit(signal)
    // A directory revision is announced, not rediscovered: the core owns the
    // snapshot, and a list main already handed to a page would otherwise stay
    // stale until something happened to read it again.
    if (method === 'directory.changed') {
      const changed = exactPeerObject(payload, ['serviceId', 'revision'])
      assertAccountId(changed.serviceId, 12)
      // A revision is counted from zero by the core, and anything else is a
      // callback this shell cannot route.
      if (!Number.isSafeInteger(changed.revision) || (changed.revision as number) < 0)
        throw new PeerHelperError('p2p.invalid_payload')
      this.options.onDirectoryChange?.(changed.serviceId)
      return {}
    }
    // A catalog revision is announced for the same reason as a directory one: a
    // list main already handed to a page cannot see the computers the core has
    // recorded since. Nothing is authorized here on purpose — this is an
    // announcement, not a request, so it is not gated by `#authorize`; a page
    // that acts on it re-reads through the admitted operation, which is.
    if (method === 'catalog.changed') {
      const changed = exactPeerObject(payload, ['serviceId', 'revision'])
      assertAccountId(changed.serviceId, 12)
      // The catalog's revision is the sha256 of the stored record, so anything
      // else is a callback this shell cannot route.
      if (typeof changed.revision !== 'string' || !/^[a-f0-9]{64}$/.test(changed.revision))
        throw new PeerHelperError('p2p.invalid_payload')
      this.options.onCatalogChange?.(changed.serviceId, changed.revision)
      return {}
    }
    const fields = exactPeerObject(
      payload,
      method === 'runtime.connect' ? ['serviceId', 'pairId'] : ['serviceId', 'state']
    )
    assertAccountId(fields.serviceId, 12)
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
      this.options.onPeerStage?.(fields.serviceId, pairId, state.stage)
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
    const channel = this.options.channel
    if (this.#lifetime.signal.aborted || channel === undefined) return
    // The set contains only managers that actually requested this local runtime.
    // Outgoing peers on other services never receive a local-runtime invalidation.
    await Promise.all(
      [...this.#runtimeServices].map(async (serviceId) => {
        exactPeerObject(
          await channel.call(
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
  }

  async #stop(): Promise<void> {
    this.#lifetime.abort()
    this.#runtime.close()
    this.#detach?.()
    this.#detach = undefined
    this.#runtimeServices.clear()
    this.#states.clear()
  }

  #admit(signal: AbortSignal): void {
    if (this.#failure) throw this.#failure
    if (this.#lifetime.signal.aborted) throw new PeerHelperError('p2p.helper_closed')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
  }
}
