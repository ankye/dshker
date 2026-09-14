import { PeerHelperError } from './wire'

/** One pair the shell intends to keep connected, keyed serviceId:pairId. */
interface Intent {
  serviceId: string
  pairId: string
}

export interface AutoConnectOptions {
  /** Active pairs the catalog currently authorizes; the intent source. */
  intents(): Promise<Intent[]>
  /** Live connection stage per pair, as reported by the helper. */
  stage(serviceId: string, pairId: string): string | undefined
  /** Starts one connection; resolves when the helper accepted the attempt. */
  connect(serviceId: string, pairId: string, signal: AbortSignal): Promise<unknown>
  /** Optional clock hooks so tests do not wait in real time. */
  setTimer?(callback: () => void, delayMilliseconds: number): { cancel(): void }
}

// A connection that dropped is retried with a widening delay so a peer that is
// simply off does not become a busy loop, while a brief network change recovers
// within seconds. The last delay repeats forever: the pair stays authorized, so
// the shell keeps trying until it is revoked.
const BACKOFF_MILLISECONDS = [1_000, 2_000, 5_000, 15_000, 60_000] as const

// Stages that mean a connection exists or is on its way; nothing to do.
const LIVE_STAGES = new Set(['punching', 'starting-runtime', 'ready'])

// Refusals that will not change by trying again: the pair's authorization is
// gone, so retrying would only produce the same refusal and hide the reason.
//
// The two authorization stops the core actually answers with are
// `p2p.pair_unauthorized` (this device holds no pin for the pair) and
// `p2p.network_revoked` (the network's authorization was withdrawn). Leaving
// them out is what turned "removed by another device" into a silent retry loop
// that never succeeded and never said why: the computer stayed listed as active
// and the shell re-attempted it forever, while the refusal never reached a
// surface. `clearRefusals` still forgets them when the machine's own state
// changes, so a re-authorized pair is attempted again.
const TERMINAL_CODES = new Set([
  'p2p.not_enabled',
  'p2p.pair_unauthorized',
  'p2p.network_revoked',
  'p2p.pair_revoked',
  'p2p.pair_not_found',
  'p2p.identity_mismatch',
  'p2p.trust_restore_rejected',
  'p2p.lease_rejected',
  'p2p.device_revoked',
  'p2p.unauthorized'
])

/**
 * Keeps every authorized pair connected without user action.
 *
 * The intent is the catalog: an active pair should be connected, so a drop is
 * followed by a retry rather than by a disconnected tab waiting for a click.
 * Switching tabs is deliberately not an input here — the connection outlives
 * the view, so returning to a tab never re-punches a hole that was already
 * open. Only losing authorization stops the attempts.
 */
export class PeerAutoConnect {
  readonly #options: AutoConnectOptions
  readonly #attempts = new Map<string, number>()
  readonly #timers = new Map<string, { cancel(): void }>()
  readonly #inFlight = new Set<string>()
  readonly #terminal = new Map<string, string>()
  readonly #lifetime = new AbortController()
  #closed = false

  constructor(options: AutoConnectOptions) {
    this.#options = options
  }

  /** Reports why a pair stopped being retried, for the projection to surface. */
  refusal(serviceId: string, pairId: string): string | undefined {
    return this.#terminal.get(key(serviceId, pairId))
  }

  /**
   * Brings every authorized pair up to intent once. Safe to call repeatedly:
   * a pair that is connected, connecting, or already scheduled is skipped.
   */
  async reconcile(): Promise<void> {
    if (this.#closed) return
    let intents: Intent[]
    try {
      intents = await this.#options.intents()
    } catch {
      // No catalog, no intent. A later pass picks it up once it is readable.
      return
    }
    const wanted = new Set(intents.map((intent) => key(intent.serviceId, intent.pairId)))
    for (const identifier of [...this.#timers.keys()]) {
      if (!wanted.has(identifier)) this.#forget(identifier)
    }
    for (const identifier of [...this.#terminal.keys()]) {
      if (!wanted.has(identifier)) this.#terminal.delete(identifier)
    }
    for (const intent of intents) this.#ensure(intent)
  }

  /**
   * Clears the backoff of every pair and retries now. The caller uses this when
   * the machine itself changed state — network back, waking from sleep — where
   * waiting out a 60 second delay would feel broken.
   */
  retryNow(): void {
    this.#attempts.clear()
    for (const identifier of [...this.#timers.keys()]) this.#cancelTimer(identifier)
    void this.reconcile()
  }

  /** Forgets a terminal refusal so a re-authorized pair is attempted again. */
  clearRefusals(): void {
    this.#terminal.clear()
    this.#attempts.clear()
  }

  close(): void {
    this.#closed = true
    this.#lifetime.abort()
    for (const identifier of [...this.#timers.keys()]) this.#cancelTimer(identifier)
    this.#attempts.clear()
  }

  #ensure(intent: Intent): void {
    const identifier = key(intent.serviceId, intent.pairId)
    if (this.#closed || this.#inFlight.has(identifier)) return
    if (this.#terminal.has(identifier) || this.#timers.has(identifier)) return
    const stage = this.#options.stage(intent.serviceId, intent.pairId)
    if (stage !== undefined && LIVE_STAGES.has(stage)) {
      // Connected or connecting: the attempt counter resets so the next drop
      // retries immediately instead of inheriting an old delay.
      this.#attempts.delete(identifier)
      return
    }
    void this.#attempt(intent, identifier)
  }

  async #attempt(intent: Intent, identifier: string): Promise<void> {
    this.#inFlight.add(identifier)
    try {
      await this.#options.connect(intent.serviceId, intent.pairId, this.#lifetime.signal)
      this.#attempts.delete(identifier)
    } catch (error) {
      if (this.#closed) return
      const code = error instanceof PeerHelperError ? error.code : 'p2p.operation_failed'
      if (TERMINAL_CODES.has(code)) {
        this.#terminal.set(identifier, code)
        return
      }
      // Everything else is transient by assumption: a busy helper, an
      // unreachable peer, a coordinator hiccup. None of them is the user's
      // problem to solve with a button.
      this.#schedule(intent, identifier)
    } finally {
      this.#inFlight.delete(identifier)
    }
  }

  #schedule(intent: Intent, identifier: string): void {
    if (this.#closed || this.#timers.has(identifier)) return
    const attempt = this.#attempts.get(identifier) ?? 0
    const delay = BACKOFF_MILLISECONDS[Math.min(attempt, BACKOFF_MILLISECONDS.length - 1)]
    this.#attempts.set(identifier, attempt + 1)
    const timer = (this.#options.setTimer ?? defaultTimer)(() => {
      this.#timers.delete(identifier)
      this.#ensure(intent)
    }, delay)
    this.#timers.set(identifier, timer)
  }

  #cancelTimer(identifier: string): void {
    this.#timers.get(identifier)?.cancel()
    this.#timers.delete(identifier)
  }

  #forget(identifier: string): void {
    this.#cancelTimer(identifier)
    this.#attempts.delete(identifier)
  }
}

function key(serviceId: string, pairId: string): string {
  return serviceId + ':' + pairId
}

function defaultTimer(callback: () => void, delayMilliseconds: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMilliseconds)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
