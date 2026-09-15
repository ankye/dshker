import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * This computer's session with each coordinator, as main last observed it.
 *
 * A missing entry means never attempted, which a surface reports as offline with no
 * code rather than inventing a reason. The refusal is retained rather than
 * discarded: without it the product could only say "offline" and never why, which
 * left the cause of a down session undiscoverable from the UI.
 */
export interface PeerSession {
  readonly state: 'online' | 'offline'
  readonly code: string
}

/**
 * Records what each coordinator session observed, and tells the surfaces once.
 *
 * `goOnline` runs after the window exists, so an unreachable coordinator cannot
 * delay startup; without a change notification the renderer's first read observed
 * "not attempted yet" and nothing ever corrected it, leaving a computer that had
 * since come online reported as offline. Listeners are therefore notified only on
 * an actual change, not on every sweep.
 */
export class PeerSessionRegistry {
  readonly #sessions = new Map<string, PeerSession>()
  readonly #listeners = new Set<() => void>()

  onSessionChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The recorded session for one service, or undefined when never attempted. */
  find(serviceId: string): PeerSession | undefined {
    return this.#sessions.get(serviceId)
  }

  record(serviceId: string, state: 'online' | 'offline', code: string): void {
    const previous = this.#sessions.get(serviceId)
    if (previous?.state === state && previous.code === code) return
    this.#sessions.set(serviceId, { state, code })
    for (const listener of this.#listeners) listener()
  }

  /**
   * Marks every online session offline.
   *
   * Losing the runtime ends every coordinator session it carried. Without this the
   * recorded state stayed 'online' after the helper became unavailable, which is
   * worse than reporting nothing: the surface asserted reach the computer no longer
   * had.
   */
  clear(code: string): void {
    for (const serviceId of [...this.#sessions.keys()])
      if (this.#sessions.get(serviceId)?.state === 'online') this.record(serviceId, 'offline', code)
  }
}

/**
 * Writes a failure the product cannot explain next to the records this shell owns.
 *
 * The surface only shows typed codes, so a failure that is not a named refusal used
 * to collapse into `p2p.internal_error` and the original exception was lost, which
 * left a failing join undiagnosable. Only the error's own name and message are
 * written, never a payload, key or token.
 */
export async function diagnoseShellFailure(
  root: string | undefined,
  error: unknown
): Promise<void> {
  if (root === undefined) return
  const described = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  await appendFile(
    join(root, 'dsh-launcher', 'shell-diagnostics.log'),
    `${new Date().toISOString()} ${described}\n`,
    'utf8'
  ).catch(() => undefined)
}
