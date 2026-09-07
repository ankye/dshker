import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { PeerConnections } from './connections'
import { PeerCredentialStore } from './credentials'
import { PeerEnrollment } from './enrollment'
import { PeerPairing } from './pairing'
import { PeerRemoteProjects } from './remote-projects'
import type { PeerRpc } from './rpc'
import { PeerRuntimeHost } from './runtime-host'
import { PeerServices, type PeerServiceInput } from './services'
import { exactPeerObject, PeerHelperError } from './wire'

interface Options {
  resourcesRoot: string
  resolveSettingsRoot(): Promise<string>
  runtime: Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>
}

interface Session {
  rpc: PeerRpc
  services: PeerServices
  accounts: PeerAccounts
  enrollment: PeerEnrollment
  pairing: PeerPairing
  connections: PeerConnections
  projects: PeerRemoteProjects
}

/** The formal main composition root for P2P management. No renderer gets RPC or secrets. */
export class PeerManagement {
  readonly #catalog: PeerCatalog
  readonly #credentials: PeerCredentialStore
  readonly #host: PeerRuntimeHost
  readonly #lifetime = new AbortController()
  #session: Session | undefined

  constructor(options: Options) {
    this.#catalog = new PeerCatalog(options.resolveSettingsRoot)
    this.#credentials = new PeerCredentialStore(options.resolveSettingsRoot)
    this.#host = new PeerRuntimeHost({
      resourcesRoot: options.resourcesRoot,
      catalog: this.#catalog,
      runtime: options.runtime,
      onUnavailable: () => this.#clearSession()
    })
  }

  async close(): Promise<void> {
    this.#lifetime.abort()
    this.#clearSession()
    await this.#host.close()
  }

  async enable() {
    this.#admit()
    return this.#catalog.enable()
  }
  async catalog() {
    this.#admit()
    return this.#catalog.inspect()
  }
  status() {
    return this.#host.snapshot()
  }

  async addService(revision: string, input: PeerServiceInput, signal: AbortSignal) {
    const session = await this.#ready(signal)
    return session.services.add(revision, input, this.#signal(signal))
  }

  login(serviceId: string, username: string, password: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.login(serviceId, username, password, active)
    )
  }
  currentUser(serviceId: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.currentUser(serviceId, active)
    )
  }
  logout(serviceId: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.logout(serviceId, active)
    )
  }
  networks(serviceId: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.listNetworks(serviceId, active)
    )
  }
  createNetwork(serviceId: string, name: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.createNetwork(serviceId, name, active)
    )
  }
  renameNetwork(serviceId: string, networkId: string, name: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.renameNetwork(serviceId, networkId, name, active)
    )
  }
  deleteNetwork(serviceId: string, networkId: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.deleteNetwork(serviceId, networkId, active)
    )
  }

  async registration(serviceId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.inspect(serviceId, this.#signal(signal))
  }
  async registerDevice(serviceId: string, networkId: string, name: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.register(
      serviceId,
      networkId,
      name,
      this.#signal(signal)
    )
  }
  async submitEnrollment(serviceId: string, revision: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.submitPending(
      serviceId,
      revision,
      this.#signal(signal)
    )
  }
  async recoverEnrollment(serviceId: string, revision: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.recover(serviceId, revision, this.#signal(signal))
  }

  async pairs(serviceId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.list(serviceId, this.#signal(signal))
  }
  async pairIdentity(serviceId: string, pairId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.identity(serviceId, pairId, this.#signal(signal))
  }
  async createInvite(serviceId: string, networkId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.createInvite(
      serviceId,
      networkId,
      this.#signal(signal)
    )
  }
  async acceptInvite(serviceId: string, networkId: string, code: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.acceptInvite(
      serviceId,
      networkId,
      code,
      this.#signal(signal)
    )
  }
  async approvePair(serviceId: string, pairId: string, fingerprint: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.approve(
      serviceId,
      pairId,
      fingerprint,
      this.#signal(signal)
    )
  }
  async rejectPair(serviceId: string, pairId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).pairing.reject(serviceId, pairId, this.#signal(signal))
  }
  /** Returns the catalog because revocation removes the paired computer record. */
  async revokePair(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#ready(signal)
    await session.pairing.revoke(serviceId, pairId, this.#signal(signal))
    // The pair is gone: its local entry point must not remain usable.
    session.connections.invalidate(serviceId, pairId)
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    return saved
  }

  /**
   * Updates the shared configuration of one P2P service.
   *
   * A computer counts as busy while it has any live connection stage other than
   * a settled `failed`/`disconnected`, so an endpoint change can never be
   * applied underneath an in-flight session.
   */
  async updateServiceConfig(
    serviceId: string,
    revision: string,
    input: PeerServiceInput,
    signal: AbortSignal
  ) {
    const session = await this.#ready(signal)
    const live = this.#host.snapshot()
    const busyPairs = new Set(
      live.peers
        .filter(
          (peer) =>
            peer.serviceId === serviceId &&
            peer.state.stage !== 'failed' &&
            peer.state.stage !== 'disconnected'
        )
        .map((peer) => peer.state.pairId)
    )
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const busyConnections = new Set(
      saved.record.computers
        .filter((computer) => busyPairs.has(computer.pairId))
        .map((computer) => computer.connectionId)
    )
    return session.services.updateConfig(
      revision,
      serviceId,
      input,
      (connectionId) => busyConnections.has(connectionId),
      this.#signal(signal)
    )
  }

  /** Live connection stages. Reading never starts or keeps a connection alive. */
  connections() {
    return this.#host.snapshot()
  }
  async connect(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#ready(signal)
    return session.connections.connect(serviceId, pairId, this.#signal(signal))
  }
  async disconnect(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#ready(signal)
    return session.connections.disconnect(serviceId, pairId, this.#signal(signal))
  }

  async remoteRoots(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#ready(signal)
    return session.projects.roots(serviceId, pairId, this.#signal(signal))
  }
  async remoteDirectory(
    serviceId: string,
    pairId: string,
    rootId: string,
    ref: string,
    offset: number,
    limit: number,
    signal: AbortSignal
  ) {
    const session = await this.#ready(signal)
    return session.projects.directory(
      serviceId,
      pairId,
      rootId,
      ref,
      offset,
      limit,
      this.#signal(signal)
    )
  }

  /**
   * Proves a pair is a currently authorized computer.
   *
   * Browsing a remote root is only meaningful for an active pair, and a revoked
   * one must lose access immediately rather than at the next reconnect.
   */
  async #assertActivePair(serviceId: string, pairId: string): Promise<void> {
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const active = saved.record.computers.some(
      (computer) =>
        computer.serviceId === serviceId &&
        computer.pairId === pairId &&
        computer.pairState === 'active'
    )
    if (!active) throw new PeerHelperError('p2p.pair_not_found')
  }

  async #ready(signal: AbortSignal): Promise<Session> {
    this.#admit()
    const rpc = await this.#host.start(this.#signal(signal))
    this.#admit()
    if (this.#session) return this.#session
    const services = new PeerServices(this.#catalog, rpc)
    const accounts = new PeerAccounts(rpc, (serviceId, networkId) =>
      this.#removeNetworkAuthority(rpc, serviceId, networkId)
    )
    const enrollment = new PeerEnrollment({
      services,
      accounts,
      credentials: this.#credentials,
      rpc
    })
    const pairing = new PeerPairing(
      rpc,
      async (serviceId, signal) => {
        const registration = await enrollment.inspect(serviceId, signal)
        if (registration.kind !== 'registered') throw new PeerHelperError('p2p.device_unregistered')
        return registration.deviceId
      },
      (serviceId, pairId) => this.#removePairAuthority(serviceId, pairId)
    )
    const connections = new PeerConnections(rpc)
    const projects = new PeerRemoteProjects(rpc, (service, pair) =>
      this.#assertActivePair(service, pair)
    )
    this.#session = { rpc, services, accounts, enrollment, pairing, connections, projects }
    return this.#session
  }

  async #account<T>(
    serviceId: string,
    signal: AbortSignal,
    operation: (accounts: PeerAccounts, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const session = await this.#ready(signal)
    const active = this.#signal(signal)
    await session.services.activate(serviceId, active)
    this.#admit()
    return operation(session.accounts, active)
  }

  async #removeNetworkAuthority(rpc: PeerRpc, serviceId: string, networkId: string): Promise<void> {
    // Server deletion has already committed. User cancellation must not cancel cleanup.
    try {
      exactPeerObject(
        await rpc.call(
          'network.invalidate',
          { serviceId, data: { networkId } },
          this.#lifetime.signal
        ),
        []
      )
    } catch (error) {
      await this.#host.failClosed(new PeerHelperError('p2p.authorization_cleanup_failed'))
      throw error
    }
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const computers = saved.record.computers.map((computer) =>
      computer.serviceId === serviceId && computer.networkId === networkId
        ? { ...computer, pairState: 'revoked' as const }
        : computer
    )
    // Authorization for this network is gone; drop its local entry points too.
    for (const computer of saved.record.computers)
      if (computer.serviceId === serviceId && computer.networkId === networkId)
        this.#session?.connections.invalidate(serviceId, computer.pairId)
    // Persistence failure does not undo server revocation or restore helper pins.
    await this.#catalog.commit(saved.revision, { ...saved.record, computers })
  }

  /**
   * Marks the paired computer revoked after the server accepted the revocation.
   *
   * The authorization is already gone at this point, so a persistence failure
   * must surface rather than resurrect the pair as usable.
   */
  async #removePairAuthority(serviceId: string, pairId: string): Promise<void> {
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const computers = saved.record.computers.map((computer) =>
      computer.serviceId === serviceId && computer.pairId === pairId
        ? { ...computer, pairState: 'revoked' as const }
        : computer
    )
    await this.#catalog.commit(saved.revision, { ...saved.record, computers })
  }

  #clearSession(): void {
    this.#session?.projects.close()
    this.#session?.connections.close()
    this.#session?.pairing.close()
    this.#session?.enrollment.close()
    this.#session?.accounts.close()
    this.#session?.services.close()
    this.#session = undefined
  }
  #signal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.#lifetime.signal])
  }
  #admit(): void {
    if (this.#lifetime.signal.aborted) throw new PeerHelperError('p2p.helper_closed')
  }
}
