import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { assertAccountId } from './account-records'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { PeerConnections } from './connections'
import { PeerCredentialStore, type PeerCredential } from './credentials'
import { PeerEnrollment } from './enrollment'
import { PeerPairing } from './pairing'
import type { PeerPairMember, PeerPairMemberDevice } from './pair-records'
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
  /** Services whose enrolled device has been restored into the live helper. */
  readonly #restored = new Set<string>()
  /**
   * This computer's session with each coordinator, keyed by serviceId.
   *
   * A missing entry means never attempted, which the projection reports as
   * offline with no code rather than inventing a reason. This is the network
   * layer: a pair connection is tracked separately by the runtime host.
   */
  readonly #sessions = new Map<string, { state: 'online' | 'offline'; code: string }>()
  readonly #sessionListeners = new Set<() => void>()
  #sessionSweep: ReturnType<typeof setInterval> | undefined
  readonly #resolveSettingsRoot: () => Promise<string>

  constructor(options: Options) {
    this.#resolveSettingsRoot = options.resolveSettingsRoot
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
    if (this.#sessionSweep !== undefined) clearInterval(this.#sessionSweep)
    this.#sessionSweep = undefined
    this.#lifetime.abort()
    this.#clearSession()
    await this.#host.close()
  }

  /**
   * Brings every enrolled service online at startup.
   *
   * Presence, the reported version, discoverability and pairing all depend on
   * the coordinator heartbeat, and that heartbeat only runs while a device
   * session holds the signal connection. Nothing established that session until
   * the user happened to open pairing, so a launcher that was running looked
   * offline, never reported its build, could not be found by another machine and
   * could not be driven from the web console. The offline hint shown to users
   * already promises the opposite: that starting the app is what brings a
   * computer online.
   *
   * Failure here must never block application startup: a coordinator that is
   * unreachable, a service that was never enrolled, or a revoked credential all
   * leave the app fully usable and simply offline, exactly as before.
   */
  async goOnline(): Promise<{ serviceId: string; online: boolean; code?: string }[]> {
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    if (!snapshot) return []
    const results: { serviceId: string; online: boolean; code?: string }[] = []
    for (const service of snapshot.record.services) {
      if (this.#lifetime.signal.aborted) break
      try {
        const session = await this.#readyAsDevice(service.serviceId, this.#lifetime.signal)
        this.#setSession(service.serviceId, 'online', '')
        // Devices in the same network are already authorized to reach each other,
        // so pair them without an invite. Joining a network would otherwise grant
        // nothing on its own. A refusal here still leaves the service online.
        await session.pairing.adopt(service.serviceId, this.#lifetime.signal).catch(() => undefined)
        results.push({ serviceId: service.serviceId, online: true })
      } catch (error) {
        const code = error instanceof PeerHelperError ? error.code : 'p2p.internal_error'
        // The refusal is retained rather than discarded: without it the surface
        // could only say "offline" and never why, which left the cause of a
        // down session undiscoverable from the product.
        this.#setSession(service.serviceId, 'offline', code)
        results.push({ serviceId: service.serviceId, online: false, code })
      }
    }
    return results
  }

  /**
   * Notifies when a session changes.
   *
   * goOnline runs after the window exists so an unreachable coordinator cannot
   * delay startup. Without a change notification the renderer's first read
   * therefore observed "not attempted yet" and nothing ever corrected it, so the
   * status stayed offline for a computer that had since come online.
   */
  onSessionChange(listener: () => void): () => void {
    this.#sessionListeners.add(listener)
    return () => this.#sessionListeners.delete(listener)
  }

  /**
   * Re-establishes any service that is not currently online.
   *
   * A session is not self-healing: the coordinator can drop it, the network can
   * change, or the machine can wake from sleep, and nothing in the one-shot
   * startup pass would notice. Only services that are already offline are
   * retried, so an online service's session is never disturbed by the sweep;
   * an online service only has its network membership re-synced, because that
   * can change while the session itself stays up.
   *
   * Failure is per service and never escapes: an unreachable coordinator leaves
   * the app usable and simply offline, exactly as at startup.
   */
  startSessionMaintenance(intervalMilliseconds = 60_000): void {
    if (this.#sessionSweep !== undefined) return
    this.#sessionSweep = setInterval(() => {
      if (this.#lifetime.signal.aborted) return
      void this.#sweepSessions()
    }, intervalMilliseconds)
    // Node keeps the process alive for a pending timer; this one must not.
    this.#sessionSweep.unref?.()
  }

  async #sweepSessions(): Promise<void> {
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    if (!snapshot) return
    for (const service of snapshot.record.services) {
      if (this.#lifetime.signal.aborted) return
      if (this.#sessions.get(service.serviceId)?.state === 'online') {
        // The session staying up does not mean membership stood still: a machine
        // can join the network while this one is already online. Refresh the
        // catalog the Run tabs read so the list converges without a restart.
        if (this.#session)
          await this.#refreshMembers(service.serviceId, this.#session, this.#lifetime.signal)
        continue
      }
      try {
        await this.#readyAsDevice(service.serviceId, this.#lifetime.signal)
        this.#setSession(service.serviceId, 'online', '')
      } catch (error) {
        this.#setSession(
          service.serviceId,
          'offline',
          error instanceof PeerHelperError ? error.code : 'p2p.internal_error'
        )
      }
    }
  }

  /** Records one session and notifies only on an actual change. */
  #setSession(serviceId: string, state: 'online' | 'offline', code: string): void {
    const previous = this.#sessions.get(serviceId)
    if (previous?.state === state && previous.code === code) return
    this.#sessions.set(serviceId, { state, code })
    for (const listener of this.#sessionListeners) listener()
  }

  /**
   * Reports this computer's session with every enrolled coordinator.
   *
   * A read, so it never starts or repairs a session: it states what the last
   * attempt observed. Services with no attempt are reported offline with an
   * empty code, which is honest about not having tried.
   */
  async serviceSessions(): Promise<
    { serviceId: string; state: 'online' | 'offline'; code: string }[]
  > {
    this.#admit()
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    if (!snapshot) return []
    return snapshot.record.services.map((service) => {
      const session = this.#sessions.get(service.serviceId)
      return {
        serviceId: service.serviceId,
        state: session?.state ?? 'offline',
        code: session?.code ?? ''
      }
    })
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

  /**
   * This machine's local device identity. The device id is a stable random
   * value persisted once under the settings root (independent of any
   * coordinator registration), and the name defaults to the OS hostname. The
   * UI always has a real device name and identifier to show, even before any
   * network join.
   */
  async localDevice() {
    this.#admit()
    const root = await this.#settingsRoot()
    const file = join(root, 'p2p-local-device.json')
    let deviceId: string | undefined
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as { deviceId?: unknown }
      if (typeof parsed.deviceId === 'string' && /^[0-9a-f]{32}$/.test(parsed.deviceId))
        deviceId = parsed.deviceId
    } catch {
      deviceId = undefined // First run or unreadable preset: generate below.
    }
    if (!deviceId) {
      deviceId = randomBytes(16).toString('hex')
      await mkdir(root, { recursive: true })
      await writeFile(file, JSON.stringify({ deviceId, name: hostname() }) + '\n', 'utf8')
    }
    return { deviceId, name: hostname() }
  }

  async #settingsRoot(): Promise<string> {
    const root = await this.#resolveSettingsRoot()
    if (!isAbsolute(root)) throw new PeerHelperError('p2p.settings_root_required')
    return root
  }

  async addService(revision: string, input: PeerServiceInput, signal: AbortSignal) {
    const session = await this.#ready(signal)
    return session.services.add(revision, input, this.#signal(signal))
  }

  /**
   * Removes one saved coordinator service and everything bound to it.
   *
   * This is a purely local catalog transition: the identity is forgotten (so a
   * removed server can never be silently re-trusted under the same identity),
   * the service and every computer record under it are dropped, and the live
   * session binding is cleared so no in-flight entry point outlives the record.
   * No helper round-trip is needed, so removing a server never starts or
   * reconfigures the helper.
   */
  async removeService(serviceId: string, signal: AbortSignal) {
    assertAccountId(serviceId, 64)
    this.#admit()
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
    // Local-only, tolerant removal: never contacts the coordinator, so a server
    // the user no longer runs (or a legacy record that no longer passes strict
    // re-validation) does not block deleting it.
    const committed = await this.#catalog.removeService(serviceId)
    // The service is gone from the catalog: drop its live binding and entry
    // points so nothing continues speaking as the removed service.
    if (this.#session) {
      this.#session.connections.invalidate(serviceId)
      this.#session.services.forget(serviceId)
    }
    this.#restored.delete(serviceId)
    return committed
  }

  login(serviceId: string, username: string, password: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.login(serviceId, username, password, active)
    )
  }
  register(serviceId: string, email: string, password: string, signal: AbortSignal) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.register(serviceId, email, password, active)
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
  /**
   * Reads a network's device directory together with the local device id.
   *
   * Both come from one owner call so the IPC layer never has to combine two
   * operations, which would make a single read look like two to any caller
   * counting dispatches.
   */
  async networkDevices(serviceId: string, networkId: string, signal: AbortSignal) {
    const devices = await this.#account(serviceId, signal, (accounts, active) =>
      accounts.listNetworkDevices(serviceId, networkId, active)
    )
    // A service with no registration yet simply has no local device in the list.
    const saved = await this.#credentials.loadRegistration(serviceId).catch(() => undefined)
    const localDeviceId = saved?.kind === 'registered' ? saved.credential.deviceId : ''
    return { devices, localDeviceId }
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
  updateNetworkLimit(
    serviceId: string,
    networkId: string,
    maxDevices: number,
    signal: AbortSignal
  ) {
    return this.#account(serviceId, signal, (accounts, active) =>
      accounts.updateNetworkLimit(serviceId, networkId, maxDevices, active)
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
  async joinNetwork(serviceId: string, networkId: string, name: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.join(
      serviceId,
      networkId,
      name,
      this.#signal(signal)
    )
  }
  async leaveNetwork(serviceId: string, networkId: string, deviceId: string, signal: AbortSignal) {
    return (await this.#ready(signal)).enrollment.leave(
      serviceId,
      networkId,
      deviceId,
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

  /**
   * Ready session with the enrolled device restored into the helper.
   *
   * Pairing, connections and remote browsing all speak as the enrolled device,
   * but nothing restored the saved credential into the helper after enrollment,
   * so every pairs.* call failed with device_unregistered. Restoring is
   * idempotent: the helper refusing a second restore counts as restored.
   */
  async #readyAsDevice(serviceId: string, signal: AbortSignal): Promise<Session> {
    const session = await this.#ready(signal)
    await session.services.activate(serviceId, this.#signal(signal))
    await this.#restoreUserSession(serviceId, session, this.#signal(signal)).catch(() => undefined)
    if (this.#restored.has(serviceId)) return session
    const saved = await this.#credentials.load(serviceId).catch(() => undefined)
    if (!saved || saved.credential.serviceId !== serviceId)
      throw new PeerHelperError('p2p.device_unregistered')
    try {
      exactPeerObject(
        await session.rpc.call(
          'device.restore',
          {
            serviceId,
            data: {
              device: {
                deviceId: saved.credential.deviceId,
                userId: saved.credential.userId,
                name: saved.credential.name,
                publicKey: saved.credential.publicKey,
                certificate: saved.credential.certificate
              },
              privateKey: saved.credential.privateKey,
              // Pins come from live network membership, synced right after restore.
              pins: []
            }
          },
          this.#signal(signal)
        ),
        ['deviceId']
      )
    } catch (error) {
      // Already restored in this helper process: not an error.
      if (!(error instanceof PeerHelperError) || error.code !== 'p2p.invalid_device_state')
        throw error
    }
    this.#restored.add(serviceId)
    await this.#refreshMembers(serviceId, session, this.#signal(signal), saved.credential)
    return session
  }

  /**
   * Reuses the persisted login session so a restart does not ask for the
   * password again. The server stays authoritative: any refusal drops the
   * persisted token and the user simply signs in again.
   */
  async #restoreUserSession(
    serviceId: string,
    session: Session,
    signal: AbortSignal
  ): Promise<void> {
    if (session.accounts.hasSession(serviceId)) return
    const persisted = await this.#credentials.loadUserSession(serviceId).catch(() => undefined)
    if (!persisted) return
    try {
      await session.accounts.adoptPersistedSession(
        serviceId,
        persisted.token,
        persisted.expiresAt,
        signal
      )
    } catch {
      await this.#credentials.removeUserSession(serviceId).catch(() => undefined)
    }
  }

  /**
   * Re-records the coordinator's current network members into the catalog.
   *
   * Membership is the trust source the Run tabs and the member list read, and it
   * changes while this computer stays online: another machine can join a network,
   * or the first sync can run before the login that authorises the listing. The
   * sync is therefore repeatable rather than a side effect of the first device
   * restore — otherwise a late-joining computer never reaches the catalog until
   * the helper restarts. Best-effort by design: a coordinator refusal must not
   * fail the read that triggered it, and without an enrolled credential there is
   * no identity to speak as.
   */
  async #refreshMembers(
    serviceId: string,
    session: Session,
    signal: AbortSignal,
    credential?: PeerCredential
  ): Promise<void> {
    const enrollee =
      credential ?? (await this.#credentials.load(serviceId).catch(() => undefined))?.credential
    if (!enrollee || enrollee.serviceId !== serviceId) return
    await this.#syncMembers(serviceId, session, enrollee, signal).catch((error) => {
      // Best-effort: the caller's read must still succeed. The refusal is logged
      // rather than dropped, because a silent failure here is indistinguishable
      // from "the coordinator reports no members" from every user surface.
      console.error('[p2p] network member sync failed:', error)
    })
  }

  /**
   * Re-records the coordinator's pairs as the catalog the Run route renders.
   *
   * Trust is still network membership, but the network device directory
   * deliberately withholds credential material: the peer's real public key only
   * ever reaches this device through `pairs.identity`. Sourcing the catalog from
   * the pairs is therefore the only correct read — the previous source
   * (`networks.devices`) carries no key at all, so every member was silently
   * skipped and the catalog stayed empty while the device directory showed the
   * computer online.
   */
  async #syncMembers(
    serviceId: string,
    session: Session,
    credential: { deviceId: string; userId: string; name: string; publicKey: string },
    signal: AbortSignal
  ): Promise<void> {
    const members = await session.pairing.members(serviceId, signal)
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
      await session.pairing
        .pin(serviceId, member, remote.deviceId, this.#lifetime.signal)
        .catch((error) => console.error('[p2p] pair pin failed:', error))
    }
    await this.#recordMembers(serviceId, credential, members)
  }

  /** Persists the current pairs as computer records so tabs and lists survive restarts. */
  async #recordMembers(
    serviceId: string,
    credential: { deviceId: string; userId: string; publicKey: string },
    members: readonly PeerPairMember[]
  ): Promise<void> {
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    const computers = saved.record.computers.filter((computer) => computer.serviceId !== serviceId)
    const recorded = new Set(computers.map((computer) => computer.connectionId))
    for (const member of members) {
      // The catalog only admits a positive revision and an active pair.
      if (member.state !== 'active' || member.revision <= 0) continue
      const remote = remoteSide(member, credential.deviceId)
      if (remote === undefined) continue
      const local = remote === member.initiator ? member.target : member.initiator
      if (local.deviceId !== credential.deviceId) continue
      if (!samePublicKey(local.publicKey, credential.publicKey)) continue
      if (remote.deviceId === local.deviceId) continue
      // One fixed tab per computer: a second pair with the same peer (over
      // another network) must not create a duplicate connection id.
      if (recorded.has(remote.deviceId)) continue
      recorded.add(remote.deviceId)
      computers.push({
        connectionId: remote.deviceId,
        serviceId,
        displayName: remote.name.length > 0 ? remote.name : remote.deviceId,
        // The coordinator keys a connection attempt by the TARGET DEVICE ID and
        // the lease reports it back the same way, so the id every consumer
        // (peer.connect, the connection stage lookup) must use is the device id,
        // not the pairs-table row id.
        pairId: remote.deviceId,
        networkId: member.networkId,
        localDeviceId: local.deviceId,
        remoteDeviceId: remote.deviceId,
        userId: local.userId,
        localPublicKey: local.publicKey,
        remotePublicKey: remote.publicKey,
        pairRevision: member.revision,
        pairState: 'active'
      })
    }
    await this.#catalog.commit(saved.revision, { ...saved.record, computers })
  }

  /**
   * Lists network members as the pairing surface.
   *
   * Trust is network membership: every bound device appears as an active member
   * offering a direct connection, rather than an invite flow. Membership is
   * re-synced from the coordinator on every read, because the catalog it projects
   * is otherwise only written once per helper lifetime and a machine that joins
   * later would never reach the Run tabs.
   */
  async pairs(serviceId: string, signal: AbortSignal) {
    const session = await this.#readyAsDevice(serviceId, signal)
    await this.#refreshMembers(serviceId, session, this.#signal(signal))
    const saved = await this.#catalog.inspect()
    if (!saved) throw new PeerHelperError('p2p.not_enabled')
    return saved.record.computers
      .filter((computer) => computer.serviceId === serviceId && computer.pairState === 'active')
      .map((computer) => memberAsPair(computer))
  }
  async pairIdentity(serviceId: string, pairId: string, signal: AbortSignal) {
    return (await this.#readyAsDevice(serviceId, signal)).pairing.identity(
      serviceId,
      pairId,
      this.#signal(signal)
    )
  }
  async createInvite(serviceId: string, networkId: string, signal: AbortSignal) {
    return (await this.#readyAsDevice(serviceId, signal)).pairing.createInvite(
      serviceId,
      networkId,
      this.#signal(signal)
    )
  }
  async acceptInvite(serviceId: string, networkId: string, code: string, signal: AbortSignal) {
    return (await this.#readyAsDevice(serviceId, signal)).pairing.acceptInvite(
      serviceId,
      networkId,
      code,
      this.#signal(signal)
    )
  }
  async approvePair(serviceId: string, pairId: string, fingerprint: string, signal: AbortSignal) {
    return (await this.#readyAsDevice(serviceId, signal)).pairing.approve(
      serviceId,
      pairId,
      fingerprint,
      this.#signal(signal)
    )
  }
  async rejectPair(serviceId: string, pairId: string, signal: AbortSignal) {
    return (await this.#readyAsDevice(serviceId, signal)).pairing.reject(
      serviceId,
      pairId,
      this.#signal(signal)
    )
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
    const session = await this.#readyAsDevice(serviceId, signal)
    return session.connections.connect(serviceId, pairId, this.#signal(signal))
  }
  async disconnect(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#readyAsDevice(serviceId, signal)
    return session.connections.disconnect(serviceId, pairId, this.#signal(signal))
  }

  async remoteRoots(serviceId: string, pairId: string, signal: AbortSignal) {
    const session = await this.#readyAsDevice(serviceId, signal)
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
    const accounts = new PeerAccounts(
      rpc,
      (serviceId, networkId) => this.#removeNetworkAuthority(rpc, serviceId, networkId),
      async (serviceId, session) => {
        await this.#credentials.saveUserSession(serviceId, session).catch(() => undefined)
      }
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
    // The first account operation after a restart adopts the persisted login,
    // so opening the panel does not demand the password again.
    await this.#restoreUserSession(serviceId, session, active).catch(() => undefined)
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
    // Losing the runtime ends every coordinator session it carried. Without this
    // the recorded state stayed 'online' after the helper became unavailable,
    // which is worse than reporting nothing: the surface would assert reach the
    // computer no longer had.
    for (const [serviceId, session] of this.#sessions)
      if (session.state === 'online')
        this.#setSession(serviceId, 'offline', 'p2p.helper_unavailable')
    this.#restored.clear()
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

/** Formats one network member as an always-active pair view entry. */
/** The peer side of a pair, or undefined when this device is not one of its ends. */
function remoteSide(
  member: PeerPairMember,
  localDeviceId: string
): PeerPairMemberDevice | undefined {
  if (member.initiator.deviceId === localDeviceId) return member.target
  if (member.target.deviceId === localDeviceId) return member.initiator
  return undefined
}

/** Compares two base64 public keys by their bytes rather than their encoding. */
function samePublicKey(left: string, right: string): boolean {
  return Buffer.from(left, 'base64').equals(Buffer.from(right, 'base64'))
}

function memberAsPair(computer: {
  connectionId: string
  serviceId: string
  displayName: string
  pairId: string
  networkId: string
  localDeviceId: string
  remoteDeviceId: string
  userId: string
  localPublicKey: string
  remotePublicKey: string
  pairRevision: number
  pairState: 'active' | 'revoked'
}) {
  const fingerprintOf = (base64: string): string => {
    const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
    return (digest.slice(0, 32).match(/.{4}/g) ?? []).join(' ')
  }
  return {
    pairId: computer.pairId,
    networkId: computer.networkId,
    state: 'active' as const,
    revision: computer.pairRevision,
    expiresAt: 0,
    initiator: {
      deviceId: computer.localDeviceId,
      userId: computer.userId,
      name: computer.displayName,
      fingerprint: fingerprintOf(computer.localPublicKey),
      presence: 'offline' as const
    },
    target: {
      deviceId: computer.remoteDeviceId,
      userId: computer.userId,
      name: computer.displayName,
      fingerprint: fingerprintOf(computer.remotePublicKey),
      presence: 'offline' as const
    },
    localIsInitiator: true
  }
}
