import type { PeerCatalog } from './catalog'
import type { PeerCredential, PeerCredentialStore } from './credentials'
import { recordMembers, remoteSide, type MemberCredential } from './member-catalog'
import type { PeerPairing } from './pairing'
import { PeerHelperError } from './wire'

/** Refusals that mean this machine holds no authorized pair for the service. */
const UNAUTHORIZED_MEMBER_CODES = new Set(['p2p.pair_unauthorized', 'p2p.device_unauthorized'])

/** The pairing surface one member sync talks to, taken from the live session. */
export type MemberPairing = Pick<PeerPairing, 'members' | 'pin'>

/**
 * Re-records the coordinator's network members into the catalog.
 *
 * Membership is the trust source the Run tabs and the member list read, and it
 * changes while this computer stays online — another machine can join, or the
 * first sync can run before the login that authorises the listing — so the sync
 * is repeatable rather than a side effect of one device restore. Best effort: a
 * refusal must not fail the read that triggered it.
 */
export class PeerMemberSync {
  /** Last refusal that means "no authorized pair", so it is logged once. */
  #refusal: string | undefined

  constructor(
    private readonly catalog: PeerCatalog,
    private readonly credentials: PeerCredentialStore,
    /** The owner's lifetime, which a re-pin follows rather than one caller's signal. */
    private readonly lifetime: AbortSignal
  ) {}

  async refresh(
    serviceId: string,
    pairing: MemberPairing,
    signal: AbortSignal,
    credential?: PeerCredential
  ): Promise<void> {
    const enrollee =
      credential ?? (await this.credentials.load(serviceId).catch(() => undefined))?.credential
    if (!enrollee || enrollee.serviceId !== serviceId) return
    const sync = (): Promise<void> => this.#sync(serviceId, pairing, enrollee, signal)
    await sync()
      .then(() => {
        this.#refusal = undefined
      })
      .catch(async (error) => {
        // A refusal that means this machine holds no authorized pair is an answer
        // rather than a failure: keeping rows the coordinator will not authorize is
        // what leaves dead computers on screen. The catalog is rewritten empty, and
        // the code is logged once per service so it is never swallowed.
        if (error instanceof PeerHelperError && UNAUTHORIZED_MEMBER_CODES.has(error.code)) {
          if (this.#refusal !== error.code) {
            this.#refusal = error.code
            console.error('[p2p] this machine holds no authorized pair:', error.code)
          }
          await recordMembers(this.catalog, serviceId, enrollee, []).catch((writeError) =>
            console.error('[p2p] network member prune failed:', writeError)
          )
          return
        }
        // This sync prunes pairs the coordinator no longer has: a lock collision
        // must not drop it.
        if (!(error instanceof PeerHelperError) || error.code !== 'p2p.service_busy') {
          console.error('[p2p] network member sync failed:', error)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
        await sync().catch((retried) => console.error('[p2p] network member sync failed:', retried))
      })
  }

  /**
   * Re-records the coordinator's pairs as the catalog the Run route renders.
   *
   * The network device directory withholds credential material, so this is the
   * only read that carries the peer's real public key.
   */
  async #sync(
    serviceId: string,
    pairing: MemberPairing,
    credential: MemberCredential,
    signal: AbortSignal
  ): Promise<void> {
    const members = await pairing.members(serviceId, signal)
    // Re-pin every active pair: a restored device is handed an empty pin list,
    // and the helper admits a connection only for a pair it has pinned. Pinning
    // is best-effort per pair so one refusal cannot block the catalog.
    for (const member of members) {
      if (member.state !== 'active') continue
      const remote = remoteSide(member, credential.deviceId)
      if (remote === undefined) continue
      // The helper's pin map is keyed by the connection id, which is the remote
      // device id — the same value the coordinator authorizes an attempt by.
      // A pin refusal must not block the catalog: the computer still belongs in
      // the list. The refusal is logged rather than dropped, because a silent
      // failure here is invisible from every user surface.
      await pairing
        .pin(serviceId, member, remote.deviceId, this.lifetime)
        .catch((error) => console.error('[p2p] pair pin failed:', error))
    }
    // Persists the current pairs as computer records so tabs and lists survive restarts.
    await recordMembers(this.catalog, serviceId, credential, members)
  }
}
