import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import type { LauncherHarnessLaunchView } from '../../../src/shared/contracts'
import { PeerHelperError } from './wire'

export interface PeerRuntimeBinding {
  generation: number
  url: string
}
type RuntimeSource = Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>

/** Binds to the actual child announcement and invalidates synchronously on lifecycle events. */
export class PeerRuntimeOwner {
  readonly #unsubscribe: () => void
  readonly #waiters = new Set<{
    resolve(value: PeerRuntimeBinding): void
    reject(error: unknown): void
  }>()
  #binding: PeerRuntimeBinding | undefined
  #generation = 0
  #starting: Promise<void> | undefined
  #closed = false

  constructor(
    private readonly source: RuntimeSource,
    private readonly invalidate: (generation: number) => void
  ) {
    this.#accept(source.getRuntimeState())
    this.#unsubscribe = source.onRuntimeState((state) => this.#accept(state))
  }

  connect(signal: AbortSignal): Promise<PeerRuntimeBinding> {
    if (this.#closed) return Promise.reject(new PeerHelperError('p2p.runtime_owner_closed'))
    if (signal.aborted) return Promise.reject(new PeerHelperError('p2p.request_cancelled'))
    if (this.#binding) return Promise.resolve({ ...this.#binding })
    const waiting = this.#wait(signal)
    const current = this.source.getRuntimeState()
    if (current.kind !== 'starting' && !this.#starting) {
      // Each caller waits independently. Cancelling a request never kills a DSH
      // start already accepted by the runtime owner or starts another process.
      this.#starting = this.source
        .start()
        .then(
          () => {
            const settled = this.source.getRuntimeState()
            if (settled.kind === 'stopped' || settled.kind === 'failed')
              this.#reject(new PeerHelperError('p2p.runtime_unavailable'))
          },
          (error: unknown) => this.#reject(error)
        )
        .finally(() => {
          this.#starting = undefined
        })
    }
    return waiting
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe()
    this.#reject(new PeerHelperError('p2p.runtime_owner_closed'))
    this.#retire()
  }

  /** Recheck after asynchronous authorization before a binding leaves main. */
  assertCurrent(binding: PeerRuntimeBinding): void {
    if (
      this.#closed ||
      !this.#binding ||
      this.#binding.generation !== binding.generation ||
      this.#binding.url !== binding.url
    )
      throw new PeerHelperError('p2p.runtime_invalidated')
  }

  #accept(state: LauncherHarnessLaunchView): void {
    if (this.#closed) return
    if (state.kind !== 'running') {
      this.#retire()
      if (!this.#starting && (state.kind === 'failed' || state.kind === 'stopped'))
        this.#reject(new PeerHelperError('p2p.runtime_unavailable'))
      return
    }
    if (this.#binding?.url !== state.url) {
      this.#retire()
      this.#binding = { generation: ++this.#generation, url: state.url }
    }
    for (const waiter of [...this.#waiters]) waiter.resolve({ ...this.#binding })
  }

  #retire(): void {
    const previous = this.#binding
    this.#binding = undefined
    if (previous) this.invalidate(previous.generation)
  }

  #reject(error: unknown): void {
    for (const waiter of [...this.#waiters]) waiter.reject(error)
  }

  #wait(signal: AbortSignal): Promise<PeerRuntimeBinding> {
    return new Promise((resolve, reject) => {
      const finish = (result: PeerRuntimeBinding | undefined, error?: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.#waiters.delete(waiter)
        if (result) resolve(result)
        else reject(error)
      }
      const waiter = {
        resolve: (value: PeerRuntimeBinding) => finish(value),
        reject: (error: unknown) => finish(undefined, error)
      }
      const abort = () => waiter.reject(new PeerHelperError('p2p.request_cancelled'))
      const timer = setTimeout(
        () => waiter.reject(new PeerHelperError('p2p.runtime_timeout')),
        70_000
      )
      signal.addEventListener('abort', abort, { once: true })
      this.#waiters.add(waiter)
    })
  }
}
