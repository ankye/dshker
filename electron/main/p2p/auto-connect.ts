// The shell's view of the core's reconnection engine.
//
// This replaced a full implementation that used to live here. The behavior was
// correct but it was the *shell's*, so a headless host — the machine that has no
// user to click "connect" — held authorized pairs and never re-established one
// that dropped. The schedule, the terminal-refusal set and the
// clear-on-reauthorization rule now live in the core (`internal/autoconnect`), and
// this class only forwards the events the shell uniquely observes.
//
// What the shell still knows that the core does not: which stage transition just
// happened in its own projection, and when the user asked to resume connectivity.
// What it deliberately no longer knows: how long to wait, and which refusal is
// final. Keeping those here is what made two implementations of one behavior.
import type { PeerRpc } from './rpc'

/** The reconnection operations the shell drives, wherever they are served. */
export interface AutoConnectPort {
  /** Brings every authorized pair of one service up to intent once. */
  reconcile(serviceId: string, signal?: AbortSignal): Promise<void>
  /** Clears every backoff and retries now, after the machine itself changed state. */
  retryNow(serviceId: string, signal?: AbortSignal): Promise<void>
  /** Forgets terminal refusals so a re-authorized pair is attempted again. */
  clearRefusals(serviceId: string, signal?: AbortSignal): Promise<void>
}

/** A reconciliation pass starts attempts; it does not await their outcome. */
const CALL_BUDGET_MS = 30_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

/** Drives the core's peer.autoconnect_* methods over its private channel. */
export class CoreAutoConnect implements AutoConnectPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  /**
   * Sends one engine operation.
   *
   * Refusals are swallowed on purpose. These are background maintenance calls made
   * from stage transitions and catalog revisions, not user operations: a core that
   * is not configured yet, or a service that was just removed, must not turn a
   * routine sweep into an unhandled rejection in the shell. A refusal that matters
   * to the user surfaces through the connection it belongs to instead.
   */
  async #send(method: string, serviceId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#rpc.call(method, { serviceId, data: {} }, budget(signal))
    } catch {
      // Intentionally ignored; see above.
    }
  }

  async reconcile(serviceId: string, signal?: AbortSignal): Promise<void> {
    await this.#send('peer.autoconnect_reconcile', serviceId, signal)
  }

  async retryNow(serviceId: string, signal?: AbortSignal): Promise<void> {
    await this.#send('peer.autoconnect_retry_now', serviceId, signal)
  }

  async clearRefusals(serviceId: string, signal?: AbortSignal): Promise<void> {
    await this.#send('peer.autoconnect_clear_refusals', serviceId, signal)
  }
}
