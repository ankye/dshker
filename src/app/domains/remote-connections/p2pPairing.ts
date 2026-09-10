import { reactive } from 'vue'
import type { P2PInviteView, P2PPairView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PPairingState {
  pairs: P2PPairView[] | undefined
  /** Identity being confirmed, loaded on demand because list replies carry ids only. */
  reviewing: P2PPairView | undefined
  /** Exactly what the user typed/checked; approval requires it to match. */
  confirmDraft: string
  codeDraft: string
  /** Shown once after minting; never re-readable. */
  issuedInvite: P2PInviteView | undefined
  /** A write whose outcome is unknown: block further writes, allow readback. */
  resultUnconfirmed: boolean
}

/**
 * Public pairing state for the renderer.
 *
 * Two rules shape this layer. A write whose result is unknown sets
 * `resultUnconfirmed` and blocks further writes until a readback resolves it,
 * so nothing is silently retried against the server. And approval never sends
 * an implicit confirmation: the user's typed fingerprint travels to main, which
 * compares it against the real remote key.
 */
export class P2PPairingDomain {
  readonly #states = reactive<Record<string, P2PPairingState>>({})
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): P2PPairingState {
    if (!this.#states[serviceId])
      this.#states[serviceId] = {
        pairs: undefined,
        reviewing: undefined,
        confirmDraft: '',
        codeDraft: '',
        issuedInvite: undefined,
        resultUnconfirmed: false
      }
    return this.#states[serviceId]
  }

  /** Reading is always allowed; it is how an unconfirmed write gets resolved. */
  async read(serviceId: string): Promise<void> {
    const result = await this.management.runRead('pairs', { serviceId })
    if (result.ok) {
      const state = this.state(serviceId)
      state.pairs = result.data
      state.resultUnconfirmed = false
    }
  }

  /** Loads full identities so the user can compare a real fingerprint. */
  async review(serviceId: string, pairId: string): Promise<void> {
    const result = await this.management.run('pairIdentity', { serviceId, pairId })
    if (result.ok) {
      const state = this.state(serviceId)
      state.reviewing = result.data
      state.confirmDraft = ''
    }
  }

  closeReview(serviceId: string): void {
    const state = this.state(serviceId)
    state.reviewing = undefined
    state.confirmDraft = ''
  }

  /** The remote side of the pair under review, whichever side this device is. */
  remoteOf(pair: P2PPairView): P2PPairView['initiator'] {
    return pair.localIsInitiator ? pair.target : pair.initiator
  }

  async createInvite(serviceId: string, networkId: string): Promise<void> {
    const state = this.state(serviceId)
    if (!this.#canWrite(serviceId)) return
    state.issuedInvite = undefined
    const result = await this.management.run('createInvite', { serviceId, networkId })
    if (result.ok) state.issuedInvite = result.data
    else this.#recordWriteOutcome(state, result.code)
  }

  dismissInvite(serviceId: string): void {
    this.state(serviceId).issuedInvite = undefined
  }

  async acceptInvite(serviceId: string, networkId: string): Promise<void> {
    const state = this.state(serviceId)
    if (!this.#canWrite(serviceId) || !state.codeDraft) return
    const code = state.codeDraft
    const result = await this.management.run('acceptInvite', { serviceId, networkId, code })
    if (result.ok) {
      // Keep the draft on failure so a typo is correctable, clear it on success.
      if (state.codeDraft === code) state.codeDraft = ''
      state.reviewing = result.data
      await this.read(serviceId)
    } else this.#recordWriteOutcome(state, result.code)
  }

  /**
   * Approves the pair under review using the fingerprint the user confirmed.
   *
   * A mismatch is reported by main rather than decided here, so the comparison
   * always happens against the authoritative remote key.
   */
  async approve(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    const pair = state.reviewing
    if (!pair || !this.#canWrite(serviceId) || !state.confirmDraft) return
    const result = await this.management.run('approvePair', {
      serviceId,
      pairId: pair.pairId,
      fingerprint: state.confirmDraft
    })
    if (result.ok) {
      state.reviewing = result.data.state === 'active' ? undefined : result.data
      state.confirmDraft = ''
      await this.read(serviceId)
    } else if (result.code === 'p2p.pair_fingerprint_mismatch') {
      // A refused confirmation is a definite answer, not an unknown result.
      state.resultUnconfirmed = false
    } else this.#recordWriteOutcome(state, result.code)
  }

  async reject(serviceId: string, pairId: string): Promise<void> {
    const state = this.state(serviceId)
    if (!this.#canWrite(serviceId)) return
    const result = await this.management.run('rejectPair', { serviceId, pairId })
    if (result.ok) {
      if (state.reviewing?.pairId === pairId) state.reviewing = undefined
      await this.read(serviceId)
    } else this.#recordWriteOutcome(state, result.code)
  }

  async revoke(serviceId: string, pairId: string): Promise<void> {
    const state = this.state(serviceId)
    if (!this.#canWrite(serviceId)) return
    const result = await this.management.run('revokePair', { serviceId, pairId })
    if (result.ok) {
      if (state.reviewing?.pairId === pairId) state.reviewing = undefined
      await this.read(serviceId)
    } else this.#recordWriteOutcome(state, result.code)
  }

  /** Writes are blocked while busy or while a previous outcome is unknown. */
  #canWrite(serviceId: string): boolean {
    return !this.management.busy(serviceId) && !this.state(serviceId).resultUnconfirmed
  }

  /**
   * Classifies a failed write.
   *
   * Codes that prove the request never took effect leave state clean; anything
   * else may have committed on the server, so it must be treated as unknown.
   */
  #recordWriteOutcome(state: P2PPairingState, code: string): void {
    const rejectedBeforeEffect = [
      'bridge',
      'p2p.service_busy',
      'p2p.invalid_request',
      'p2p.invite_invalid',
      'p2p.invite_expired',
      'p2p.pair_not_found',
      'p2p.pair_state_mismatch',
      'p2p.pair_fingerprint_mismatch',
      'p2p.user_login_required',
      'p2p.device_unregistered',
      'p2p.request_cancelled'
    ]
    if (!rejectedBeforeEffect.includes(code)) state.resultUnconfirmed = true
  }
}

export const p2pPairing = new P2PPairingDomain(p2pManagement)
