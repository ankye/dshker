import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PeerHelperError } from './wire'

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
 * Reuses the persisted login session so a restart does not ask for the password
 * again. Only an explicit server-side account refusal removes the durable
 * session. A locked credential store, helper contention or a dead transport is
 * transient and must leave the session available for a later retry.
 */
export async function restoreUserSession(
  credentials: {
    loadUserSession: (serviceId: string) => Promise<
      | {
          token: string
          expiresAt: number
        }
      | undefined
    >
    removeUserSession: (serviceId: string) => Promise<void>
  },
  session: {
    accounts: {
      hasSession: (serviceId: string) => boolean
      adoptPersistedSession: (
        serviceId: string,
        token: string,
        expiresAt: number,
        signal: AbortSignal
      ) => Promise<unknown>
    }
  },
  serviceId: string,
  signal: AbortSignal
): Promise<void> {
  if (session.accounts.hasSession(serviceId)) return
  // A missing record is already represented by `undefined` from the credential
  // store. Do not turn provider/transport failures into that same value: doing
  // so makes the next `user.current` call report `user_login_required`, which is
  // indistinguishable from a real logout and makes the renderer show a login form
  // during a restart or installation while the durable session is still intact.
  const persisted = await credentials.loadUserSession(serviceId)
  if (!persisted) return
  try {
    await session.accounts.adoptPersistedSession(
      serviceId,
      persisted.token,
      persisted.expiresAt,
      signal
    )
  } catch (error) {
    // Only an authoritative account refusal proves that the durable session is
    // no longer usable. Transport/helper contention must leave it intact so the
    // next startup/read can retry instead of turning a temporary race into a
    // visible login form.
    if (isAuthoritativeSessionRefusal(error)) {
      await credentials.removeUserSession(serviceId).catch(() => undefined)
      return
    }
    throw error
  }
}

function isAuthoritativeSessionRefusal(error: unknown): boolean {
  if (!(error instanceof PeerHelperError)) return false
  return (
    error.code === 'p2p.user_login_required' ||
    error.code === 'p2p.user_unauthorized' ||
    error.code === 'p2p.user_session_expired'
  )
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
