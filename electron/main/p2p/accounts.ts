import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'
import {
  assertAccountId,
  assertAccountText,
  assertAccountUsername,
  peerNetwork,
  peerNetworks,
  peerUser,
  peerUserSession,
  type PeerNetwork,
  type PeerUser,
  type PeerUserSession
} from './account-records'

/** Named main-only account operations. Tokens never enter return values or persistence. */
export class PeerAccounts {
  readonly #sessions = new Map<string, PeerUserSession>()
  readonly #busy = new Set<string>()
  #closed = false

  constructor(
    private readonly rpc: Pick<PeerRpc, 'call'>,
    /** Required owner cleanup after confirmed authorization removal. */
    private readonly onNetworkRemoved: (serviceId: string, networkId: string) => Promise<void>
  ) {}

  close(): void {
    this.#closed = true
    this.#sessions.clear()
  }

  login(
    serviceId: string,
    username: string,
    password: string,
    signal: AbortSignal
  ): Promise<PeerUser> {
    assertAccountUsername(username)
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 72)
      throw new PeerHelperError('p2p.invalid_request')
    return this.#operation(serviceId, signal, async () => {
      const previous = this.#sessions.get(serviceId)
      if (previous && previous.expiresAt * 1000 <= Date.now()) this.#sessions.delete(serviceId)
      if (this.#sessions.has(serviceId)) throw new PeerHelperError('p2p.user_already_logged_in')
      const session = peerUserSession(
        await this.#call(serviceId, 'user.login', { username, password }, signal)
      )
      const user = peerUser(
        await this.#call(serviceId, 'user.current', { token: session.token }, signal)
      )
      if (user.userId !== session.user.userId || user.username !== session.user.username)
        throw new PeerHelperError('p2p.user_scope_mismatch')
      this.#checkExpiry(session)
      if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
      this.#sessions.set(serviceId, session)
      return { ...user }
    })
  }

  currentUser(serviceId: string, signal: AbortSignal): Promise<PeerUser> {
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      const current = peerUser(
        await this.#call(serviceId, 'user.current', { token: session.token }, signal)
      )
      if (current.userId !== session.user.userId)
        throw new PeerHelperError('p2p.user_scope_mismatch')
      return current
    })
  }

  logout(serviceId: string, signal: AbortSignal): Promise<void> {
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      // Explicit logout clears local authority even if remote revocation is unconfirmed.
      this.#sessions.delete(serviceId)
      exactPeerObject(
        await this.#call(serviceId, 'user.logout', { token: session.token }, signal),
        []
      )
    })
  }

  /** Main registration workflow only. This grant must never become renderer state. */
  enrollmentGrant(
    serviceId: string,
    networkId: string,
    expectedUserId: string,
    signal: AbortSignal
  ): Promise<{ token: string; networkId: string; expiresAt: number }> {
    assertAccountId(networkId)
    assertAccountId(expectedUserId)
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      if (session.user.userId !== expectedUserId)
        throw new PeerHelperError('p2p.user_scope_mismatch')
      await this.#ownedNetwork(serviceId, session, networkId, signal)
      const result = exactPeerObject(
        await this.#call(
          serviceId,
          'device.enrollmentToken',
          {
            token: session.token,
            networkId
          },
          signal
        ),
        ['token', 'networkId', 'expiresAt']
      )
      assertAccountId(result.token, 64)
      if (
        result.networkId !== networkId ||
        !Number.isSafeInteger(result.expiresAt) ||
        (result.expiresAt as number) * 1000 <= Date.now()
      )
        throw new PeerHelperError('p2p.invalid_enrollment_grant')
      return { token: result.token, networkId, expiresAt: result.expiresAt as number }
    })
  }

  listNetworks(serviceId: string, signal: AbortSignal): Promise<PeerNetwork[]> {
    return this.#operation(serviceId, signal, () =>
      this.#networks(serviceId, this.#session(serviceId), signal)
    )
  }

  createNetwork(serviceId: string, name: string, signal: AbortSignal): Promise<PeerNetwork> {
    assertAccountText(name)
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      const created = peerNetwork(
        await this.#call(serviceId, 'networks.create', { token: session.token, name }, signal),
        session.user.userId
      )
      if (created.name !== name) throw new PeerHelperError('p2p.management_result_unconfirmed')
      return this.#readNetwork(serviceId, session, created, signal)
    })
  }

  renameNetwork(
    serviceId: string,
    networkId: string,
    name: string,
    signal: AbortSignal
  ): Promise<PeerNetwork> {
    assertAccountId(networkId)
    assertAccountText(name)
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      const previous = await this.#ownedNetwork(serviceId, session, networkId, signal)
      if (previous.name === name) return previous
      const updated = peerNetwork(
        await this.#call(
          serviceId,
          'networks.rename',
          { token: session.token, networkId, name },
          signal
        ),
        session.user.userId
      )
      if (updated.networkId !== networkId || updated.name !== name)
        throw new PeerHelperError('p2p.management_result_unconfirmed')
      return this.#readNetwork(serviceId, session, updated, signal)
    })
  }

  deleteNetwork(serviceId: string, networkId: string, signal: AbortSignal): Promise<void> {
    assertAccountId(networkId)
    return this.#operation(serviceId, signal, async () => {
      const session = this.#session(serviceId)
      await this.#ownedNetwork(serviceId, session, networkId, signal)
      const result = await this.#call(
        serviceId,
        'networks.delete',
        { token: session.token, networkId },
        signal
      )
      exactPeerObject(result, [])
      // Cleanup cannot be cancelled after the server has confirmed revocation.
      await this.onNetworkRemoved(serviceId, networkId)
      const remaining = await this.#networks(serviceId, session, signal)
      if (remaining.some((value) => value.networkId === networkId))
        throw new PeerHelperError('p2p.management_result_unconfirmed')
    })
  }

  async #ownedNetwork(
    serviceId: string,
    session: PeerUserSession,
    networkId: string,
    signal: AbortSignal
  ): Promise<PeerNetwork> {
    const network = (await this.#networks(serviceId, session, signal)).find(
      (value) => value.networkId === networkId
    )
    if (!network) throw new PeerHelperError('p2p.network_unavailable')
    return network
  }

  async #readNetwork(
    serviceId: string,
    session: PeerUserSession,
    expected: PeerNetwork,
    signal: AbortSignal
  ): Promise<PeerNetwork> {
    const actual = (await this.#networks(serviceId, session, signal)).find(
      (value) => value.networkId === expected.networkId
    )
    if (!actual || actual.userId !== expected.userId || actual.name !== expected.name)
      throw new PeerHelperError('p2p.management_result_unconfirmed')
    return actual
  }

  async #networks(
    serviceId: string,
    session: PeerUserSession,
    signal: AbortSignal
  ): Promise<PeerNetwork[]> {
    this.#checkExpiry(session)
    return peerNetworks(
      await this.#call(serviceId, 'networks.list', { token: session.token }, signal),
      session.user.userId
    )
  }

  #session(serviceId: string): PeerUserSession {
    const session = this.#sessions.get(serviceId)
    if (!session) throw new PeerHelperError('p2p.user_login_required')
    try {
      this.#checkExpiry(session)
    } catch (error) {
      this.#sessions.delete(serviceId)
      throw error
    }
    return session
  }

  #checkExpiry(session: PeerUserSession): void {
    if (session.expiresAt * 1000 <= Date.now())
      throw new PeerHelperError('p2p.user_session_expired')
  }

  async #call(
    serviceId: string,
    method: string,
    data: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    this.#assertOpen()
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    try {
      const result = await this.rpc.call(method, { serviceId, data }, signal)
      this.#assertOpen()
      return result
    } catch (error) {
      if (
        error instanceof PeerHelperError &&
        (error.code === 'p2p.user_unauthorized' || error.code === 'p2p.user_session_expired')
      ) {
        this.#sessions.delete(serviceId)
      }
      throw error
    }
  }

  async #operation<T>(
    serviceId: string,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    assertAccountId(serviceId, 64)
    this.#assertOpen()
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    if (this.#busy.has(serviceId)) throw new PeerHelperError('p2p.service_busy')
    this.#busy.add(serviceId)
    try {
      return await operation()
    } finally {
      this.#busy.delete(serviceId)
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new PeerHelperError('p2p.helper_unavailable')
  }
}
