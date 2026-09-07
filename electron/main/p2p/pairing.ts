import type { PeerRpc } from './rpc'
import {
  assertConfirmedFingerprint,
  peerInvite,
  peerPairIdentity,
  peerPairs,
  type PeerInvite,
  type PeerPair
} from './pair-records'
import { assertAccountId } from './account-records'
import { PeerHelperError } from './wire'

/**
 * Named main-only pairing operations.
 *
 * The pairing sequence is deliberately two-sided: an invite is minted by one
 * computer (`createInvite`), consumed by the other (`acceptInvite`), and only
 * becomes usable once the approving side has confirmed the remote fingerprint
 * (`approve`). No step here can produce an `active` pair on its own, so an
 * unknown device is never silently authorized.
 *
 * Every write is followed by a readback of the authoritative record, and a
 * per-service lock serializes operations so two concurrent approvals cannot
 * interleave against one relationship.
 */
export class PeerPairing {
  readonly #busy = new Set<string>()
  #closed = false

  constructor(
    private readonly rpc: Pick<PeerRpc, 'call'>,
    /** Resolves this device's enrolled id for the service; decides pair sidedness. */
    private readonly localDeviceId: (serviceId: string, signal: AbortSignal) => Promise<string>,
    /** Required owner cleanup after a confirmed revocation commits on the server. */
    private readonly onPairRevoked: (serviceId: string, pairId: string) => Promise<void>
  ) {}

  close(): void {
    this.#closed = true
  }

  /** Reads every pairing relationship this device participates in. */
  list(serviceId: string, signal: AbortSignal): Promise<PeerPair[]> {
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      return peerPairs(await this.#call(serviceId, 'pairs.list', {}, signal), local)
    })
  }

  /** Reads one relationship with both device identities and real fingerprints. */
  identity(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerPair> {
    assertAccountId(pairId)
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      return this.#identity(serviceId, pairId, local, signal)
    })
  }

  /**
   * Mints a single-use invite for a network.
   *
   * The returned code is a bearer secret handed to the user for out-of-band
   * transfer; it is intentionally not persisted and cannot be re-read.
   */
  createInvite(serviceId: string, networkId: string, signal: AbortSignal): Promise<PeerInvite> {
    assertAccountId(networkId)
    return this.#operation(serviceId, signal, async () =>
      peerInvite(await this.#call(serviceId, 'pairs.share', { networkId }, signal), networkId)
    )
  }

  /**
   * Consumes an invite code, creating a pending relationship.
   *
   * The resulting pair still requires the other side to approve, so this never
   * returns an active pair.
   */
  acceptInvite(
    serviceId: string,
    networkId: string,
    code: string,
    signal: AbortSignal
  ): Promise<PeerPair> {
    assertAccountId(networkId)
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(code))
      throw new PeerHelperError('p2p.invite_invalid')
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      const created = await this.#call(serviceId, 'pairs.invite', { code, networkId }, signal)
      const pairId = this.#pairId(created)
      // Read the authoritative record rather than trusting the write reply.
      return this.#identity(serviceId, pairId, local, signal)
    })
  }

  /**
   * Approves a pending pair after the user confirmed the remote fingerprint.
   *
   * `confirmed` is the exact value shown in the UI. It is compared against the
   * locally derived fingerprint of the real remote key before any approval is
   * sent, so confirming a substituted identity fails instead of authorizing it.
   * The pinned identity is stored in the helper only after the server reports
   * the pair active.
   */
  approve(
    serviceId: string,
    pairId: string,
    confirmed: string,
    signal: AbortSignal
  ): Promise<PeerPair> {
    assertAccountId(pairId)
    assertConfirmedFingerprint(confirmed)
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      const before = await this.#identity(serviceId, pairId, local, signal)
      const remote = before.localIsInitiator ? before.target : before.initiator
      if (remote.fingerprint !== confirmed)
        throw new PeerHelperError('p2p.pair_fingerprint_mismatch')
      if (
        before.state !== 'pending_target_approval' &&
        before.state !== 'pending_initiator_confirmation'
      )
        throw new PeerHelperError('p2p.pair_state_mismatch')
      await this.#call(
        serviceId,
        'pairs.action',
        { pairId, action: 'approve', fingerprint: confirmed },
        signal
      )
      const after = await this.#identity(serviceId, pairId, local, signal)
      // Identity must not change across an approval.
      if (
        after.initiator.deviceId !== before.initiator.deviceId ||
        after.target.deviceId !== before.target.deviceId ||
        (after.localIsInitiator ? after.target : after.initiator).fingerprint !== confirmed
      )
        throw new PeerHelperError('p2p.identity_mismatch')
      if (after.state === 'active') await this.#pin(serviceId, pairId, signal)
      return after
    })
  }

  /** Rejects a pending pair. Nothing is pinned and no authorization is created. */
  reject(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerPair> {
    assertAccountId(pairId)
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      await this.#call(
        serviceId,
        'pairs.action',
        { pairId, action: 'reject', fingerprint: '' },
        signal
      )
      return this.#identity(serviceId, pairId, local, signal)
    })
  }

  /**
   * Revokes an established pair.
   *
   * Once the server accepts the revocation the owner cleanup runs even if the
   * caller cancelled, because the authorization is already gone; a persistence
   * failure afterwards must not resurrect the pair.
   */
  revoke(serviceId: string, pairId: string, signal: AbortSignal): Promise<PeerPair> {
    assertAccountId(pairId)
    return this.#operation(serviceId, signal, async () => {
      const local = await this.localDeviceId(serviceId, signal)
      await this.#call(
        serviceId,
        'pairs.action',
        { pairId, action: 'revoke', fingerprint: '' },
        signal
      )
      const after = await this.#identity(serviceId, pairId, local, signal)
      await this.onPairRevoked(serviceId, pairId)
      return after
    })
  }

  async #identity(
    serviceId: string,
    pairId: string,
    localDeviceId: string,
    signal: AbortSignal
  ): Promise<PeerPair> {
    const pair = peerPairIdentity(
      await this.#call(serviceId, 'pairs.identity', { pairId }, signal),
      localDeviceId
    )
    if (pair.pairId !== pairId) throw new PeerHelperError('p2p.identity_mismatch')
    return pair
  }

  /** Pins the confirmed remote identity so a later key substitution is refused. */
  async #pin(serviceId: string, pairId: string, signal: AbortSignal): Promise<void> {
    await this.#call(serviceId, 'pairs.pin', { pairId }, signal)
  }

  #pairId(value: unknown): string {
    if (typeof value !== 'object' || value === null)
      throw new PeerHelperError('p2p.invalid_payload')
    const pairId = (value as { pairId?: unknown }).pairId
    assertAccountId(pairId)
    return pairId
  }

  async #call(
    serviceId: string,
    method: string,
    data: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    this.#admit()
    return this.rpc.call(method, { serviceId, data }, signal)
  }

  /** One in-flight pairing operation per service; concurrent attempts are refused. */
  async #operation<T>(
    serviceId: string,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    assertAccountId(serviceId, 64)
    this.#admit()
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    if (this.#busy.has(serviceId)) throw new PeerHelperError('p2p.service_busy')
    this.#busy.add(serviceId)
    try {
      return await operation()
    } finally {
      this.#busy.delete(serviceId)
    }
  }

  #admit(): void {
    if (this.#closed) throw new PeerHelperError('p2p.helper_closed')
  }
}
