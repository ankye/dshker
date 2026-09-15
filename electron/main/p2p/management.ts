import { hostname } from 'node:os'
import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { assertAccountId } from './account-records'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { peerPartition } from './partitions'
import { PeerConnections } from './connections'
import { PeerCredentialStore, type PeerCredential } from './credentials'
import { PeerEnrollment } from './enrollment'
import { enrollWhenMissing } from './enrollment-bootstrap'
import { PeerPairing } from './pairing'
import type { PeerPairMember } from './pair-records'
import { PeerRemoteProjects } from './remote-projects'
import { PeerRuntimeHost, type PeerChannel } from './runtime-host'
import { recordMembers, remoteSide } from './member-catalog'
import { diagnoseShellFailure, PeerSessionRegistry } from './session-registry'

/** Refusals that mean this machine holds no authorized pair for the service. */
const UNAUTHORIZED_MEMBER_CODES = new Set(['p2p.pair_unauthorized', 'p2p.device_unauthorized'])
import { P2PSelectionStore } from './selection-preferences'
import { PeerServices, type PeerServiceInput } from './services'
import { exactPeerObject, PeerHelperError } from './wire'
import { memberAsPair } from './management-projection'
import { PeerAutoConnect } from './auto-connect'
import type { CoreCatalogPort } from '../core/catalog'
import type { CoreSecretPort } from '../core/secrets'

interface Options {
  /** The core's private channel. Absent when the shell could not start a core. */
  channel?: PeerChannel
  resolveSettingsRoot(): Promise<string>
  secrets?: CoreSecretPort
  catalog?: CoreCatalogPort
  runtime: Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>
}

interface Session {
  rpc: PeerChannel
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
   * This computer's session with each coordinator.
   *
   * The network layer, kept separate from a pair connection, which the runtime host
   * tracks: this is "am I online with the coordinator?", not "is one peer's
   * workbench reachable?".
   */
  readonly #sessions = new PeerSessionRegistry()
  #sessionSweep: ReturnType<typeof setInterval> | undefined
  readonly #autoConnect: PeerAutoConnect
  readonly #resolveSettingsRoot: () => Promise<string>
  readonly #selection: P2PSelectionStore
  /** Last member-sync refusal that means "no authorized pair", so it logs once. */
  #memberRefusal: string | undefined

  constructor(options: Options) {
    this.#resolveSettingsRoot = options.resolveSettingsRoot
    this.#selection = new P2PSelectionStore({ resolveSettingsRoot: options.resolveSettingsRoot })
    this.#catalog = new PeerCatalog(options.resolveSettingsRoot, options.catalog)
    this.#credentials = new PeerCredentialStore(options.resolveSettingsRoot, options.secrets)
    this.#host = new PeerRuntimeHost({
      channel: options.channel,
      catalog: this.#catalog,
      runtime: options.runtime,
      onUnavailable: () => this.#clearSession(),
      // A drop is retried at once rather than at the next sweep: the hole is
      // usually re-punchable within a second of a network change, and a tab the
      // user may switch back to at any moment must not sit dead in between.
      onPeerStage: (_serviceId, _pairId, stage) => {
        if (stage === 'disconnected' || stage === 'failed') void this.#autoConnect.reconcile()
      }
    })
    // An active pair is meant to be connected. Nothing about which tab the user
    // is looking at takes part: the connection outlives the view, so switching
    // back to a tab finds the hole still open instead of re-punching it.
    this.#autoConnect = new PeerAutoConnect({
      intents: async () => {
        const snapshot = await this.#catalog.inspect()
        if (!snapshot) return []
        return snapshot.record.computers
          .filter((computer) => computer.pairState === 'active')
          .map((computer) => ({ serviceId: computer.serviceId, pairId: computer.pairId }))
      },
      stage: (serviceId, pairId) =>
        this.#host
          .snapshot()
          .peers.find((peer) => peer.serviceId === serviceId && peer.state.pairId === pairId)?.state
          .stage,
      connect: (serviceId, pairId, signal) => this.connect(serviceId, pairId, signal)
    })
  }

  async close(): Promise<void> {
    if (this.#sessionSweep !== undefined) clearInterval(this.#sessionSweep)
    this.#sessionSweep = undefined
    this.#autoConnect.close()
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
        await enrollWhenMissing(
          {
            credentials: this.#credentials,
            signIn: async (serviceId, signal) => {
              const session = await this.#ready(signal)
              await session.services.activate(serviceId, this.#signal(signal))
              await this.#restoreUserSession(serviceId, session, this.#signal(signal)).catch(
                () => undefined
              )
              const account = await this.#credentials
                .loadUserSession(serviceId)
                .catch(() => undefined)
              return account !== undefined
            },
            networks: (serviceId, signal) =>
              this.#account(serviceId, signal, (accounts, active) =>
                accounts.listNetworks(serviceId, active)
              ),
            createNetwork: (serviceId, signal) =>
              this.#account(serviceId, signal, (accounts, active) =>
                accounts.createNetwork(serviceId, hostname(), active)
              ),
            register: (serviceId, networkId, name) =>
              this.registerDevice(serviceId, networkId, name, this.#lifetime.signal)
          },
          service.serviceId,
          hostname(),
          this.#lifetime.signal
        )
        const session = await this.#readyAsDevice(service.serviceId, this.#lifetime.signal)
        this.#sessions.record(service.serviceId, 'online', '')
        // Devices in the same network are already authorized to reach each other,
        // so pair them without an invite. Joining a network would otherwise grant
        // nothing on its own. A refusal here still leaves the service online.
        await session.pairing.adopt(service.serviceId, this.#lifetime.signal).catch(() => undefined)
        results.push({ serviceId: service.serviceId, online: true })
      } catch (error) {
        const code = this.#refusalCode(error)
        // The refusal is retained rather than discarded: without it the surface
        // could only say "offline" and never why, which left the cause of a
        // down session undiscoverable from the product.
        this.#sessions.record(service.serviceId, 'offline', code)
        results.push({ serviceId: service.serviceId, online: false, code })
      }
    }
    // Once a coordinator session exists, bring the pairs up too: being online is
    // what the user asked for by having paired at all.
    void this.#autoConnect.reconcile()
    return results
  }

  /**
   * Notifies when a session changes. See `PeerSessionRegistry`.
   */
  onSessionChange(listener: () => void): () => void {
    return this.#sessions.onSessionChange(listener)
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

  /**
   * Retries every pair at once because the machine itself changed state.
   *
   * Waking from sleep or regaining a network invalidates whatever backoff was
   * pending: the previous delay was chosen for a peer that seemed unreachable,
   * which is no longer the situation. Sessions are swept in the same pass so a
   * coordinator that dropped while the machine slept is re-established too.
   */
  resumeConnectivity(): void {
    if (this.#lifetime.signal.aborted) return
    this.#autoConnect.clearRefusals()
    this.#autoConnect.retryNow()
    void this.#sweepSessions()
  }

  async #sweepSessions(): Promise<void> {
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    if (!snapshot) return
    for (const service of snapshot.record.services) {
      if (this.#lifetime.signal.aborted) return
      if (this.#sessions.find(service.serviceId)?.state === 'online') {
        // The session staying up does not mean membership stood still: a machine
        // can join the network while this one is already online. Refresh the
        // catalog the Run tabs read so the list converges without a restart.
        if (this.#session)
          await this.#refreshMembers(service.serviceId, this.#session, this.#lifetime.signal)
        continue
      }
      try {
        await this.#readyAsDevice(service.serviceId, this.#lifetime.signal)
        this.#sessions.record(service.serviceId, 'online', '')
      } catch (error) {
        this.#sessions.record(service.serviceId, 'offline', this.#refusalCode(error))
      }
    }
    // The same sweep repairs pair connections: a drop that happened while the
    // coordinator session stayed up is retried here without any user action.
    await this.#autoConnect.reconcile()
  }

  /**
   * Maps a failure to its typed code, recording anything it cannot explain.
   *
   * The surface only shows codes, so a failure that is not a PeerHelperError would
   * collapse into `p2p.internal_error` and the original exception would be lost,
   * leaving a failing join undiagnosable from the product.
   */
  #refusalCode(error: unknown): string {
    if (error instanceof PeerHelperError) return error.code
    void this.#resolveSettingsRoot()
      .catch(() => undefined)
      .then((root) => diagnoseShellFailure(root, error))
    return 'p2p.internal_error'
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
    return snapshot.record.services.map((service) => ({
      serviceId: service.serviceId,
      state: this.#sessions.find(service.serviceId)?.state ?? 'offline',
      code: this.#sessions.find(service.serviceId)?.code ?? ''
    }))
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
   * This machine's local device identity.
   *
   * The device id is the machine's own key id: the core keeps one device key
   * beside its data root, and every registration, member list and pair on every
   * account refers to this machine by that key's id. It is therefore read from
   * the key rather than minted here — an id invented for display looked like an
   * identifier but named a device the coordinator, the network and every peer had
   * never seen, so it could not be copied into a member list or compared with
   * anything. The name defaults to the OS hostname so the identity is readable
   * before any network is joined.
   */
  async localDevice(signal: AbortSignal) {
    this.#admit()
    const session = await this.#ready(signal)
    const identity = await session.enrollment.identity(this.#signal(signal))
    return { deviceId: identity.deviceId, name: hostname() }
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
    assertAccountId(serviceId, 12)
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
  /**
   * The devices the signed-in account is bound to, plus this machine's own id.
   *
   * The list is what decides whether this machine belongs to the account signed in
   * here: a device id can be bound to several accounts, so a locally stored
   * "account this credential was issued for" cannot answer it, and the coordinator
   * is the only side that knows.
   */
  async accountDevices(serviceId: string, signal: AbortSignal) {
    const devices = await this.#account(serviceId, signal, (accounts, active) =>
      accounts.listDevices(serviceId, active)
    )
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
    // Leaving clears this machine's credential; evicting another device does not.
    const stored = await this.#credentials.loadRegistration(serviceId).catch(() => undefined)
    if (stored?.kind === 'registered' && stored.credential.deviceId === deviceId) {
      return (await this.#ready(signal)).enrollment.leave(
        serviceId,
        networkId,
        deviceId,
        this.#signal(signal)
      )
    }
    await this.#account(serviceId, signal, (accounts, active) =>
      accounts.unbindDevice(serviceId, networkId, deviceId, active)
    )
    // The coordinator invalidates this device's pairs in the same transaction, so
    // the catalog is re-recorded right here. Waiting for the next sweep leaves the
    // dead pair as a row the user is expected to delete by hand -- which is what
    // the catalog is meant to make unnecessary.
    const session = await this.#ready(signal)
    await this.#refreshMembers(serviceId, session, this.#signal(signal))
  }
  async accountSelection(serviceId: string, userId: string) {
    return this.#selection.remembered(serviceId, userId)
  }

  async rememberAccountSelection(serviceId: string, userId: string, networkId: string) {
    return this.#selection.remember(serviceId, userId, networkId)
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
   * Pairing, connections and remote browsing all speak as the enrolled device, but
   * nothing restored the saved credential after enrollment, so every pairs.* call
   * failed with device_unregistered. Restoring is idempotent: the helper refusing
   * a second restore counts as restored.
   */
  async #readyAsDevice(serviceId: string, signal: AbortSignal): Promise<Session> {
    const session = await this.#ready(signal)
    await session.services.activate(serviceId, this.#signal(signal))
    await this.#restoreUserSession(serviceId, session, this.#signal(signal)).catch(() => undefined)
    if (this.#restored.has(serviceId)) return session
    const saved = await this.#credentials.load(serviceId).catch(() => undefined)
    if (!saved || saved.credential.serviceId !== serviceId)
      throw new PeerHelperError('p2p.device_unregistered')
    // Presence is reported for one account, and it has to be the account signed in
    // here: a machine bound to two accounts that kept reporting the one its
    // credential was first issued for stayed invisible to the account using it.
    const reportedUser = await this.#reportedAccount(serviceId, session, saved.credential, signal)
    try {
      exactPeerObject(
        await session.rpc.call(
          'device.restore',
          {
            serviceId,
            data: {
              device: {
                deviceId: saved.credential.deviceId,
                userId: reportedUser,
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
   * The account this machine reports presence for, out of the ones it belongs to.
   * Read after the persisted login is adopted; with nobody signed in, the
   * credential's own account stands. The coordinator admits only a linked account,
   * so the switch waits for its list to confirm the link.
   */
  async #reportedAccount(
    serviceId: string,
    session: Session,
    credential: { deviceId: string; userId: string },
    signal: AbortSignal
  ): Promise<string> {
    const signedIn = session.accounts.currentUserId(serviceId)
    if (signedIn === undefined || signedIn === credential.userId) return credential.userId
    const linked = await session.accounts
      .listDevices(serviceId, this.#signal(signal))
      .then((devices) => devices.some((device) => device.deviceId === credential.deviceId))
      .catch(() => false)
    return linked ? signedIn : credential.userId
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
   * changes while this computer stays online — another machine can join, or the
   * first sync can run before the login that authorises the listing — so the sync
   * is repeatable rather than a side effect of one device restore. Best effort: a
   * refusal must not fail the read that triggered it.
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
    const sync = (): Promise<void> => this.#syncMembers(serviceId, session, enrollee, signal)
    await sync()
      .then(() => {
        this.#memberRefusal = undefined
      })
      .catch(async (error) => {
        // A refusal that means this machine holds no authorized pair is an answer
        // rather than a failure: keeping rows the coordinator will not authorize is
        // what leaves dead computers on screen. The catalog is rewritten empty, and
        // the code is logged once per service so it is never swallowed.
        if (error instanceof PeerHelperError && UNAUTHORIZED_MEMBER_CODES.has(error.code)) {
          if (this.#memberRefusal !== error.code) {
            this.#memberRefusal = error.code
            console.error('[p2p] this machine holds no authorized pair:', error.code)
          }
          await recordMembers(this.#catalog, serviceId, enrollee, []).catch((writeError) =>
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
    return recordMembers(this.#catalog, serviceId, credential, members)
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

  /**
   * Hands the connected peer's workbench address to the caller that renders it.
   *
   * The address lives in main because it is a loopback gateway with a token in it:
   * the renderer is told where to point a guest, never how the gateway is reached.
   * The named attempt is the admission rule — an address from an attempt the peer
   * has already replaced is refused, so a tab cannot load a gateway its session no
   * longer owns.
   *
   * It is synchronous on purpose: no device restore, no connection attempt, no
   * retry. A tab asking for an address must never be the reason one is started.
   */
  entry(serviceId: string, pairId: string, generation: number) {
    const session = this.#session
    if (!session) throw new PeerHelperError('p2p.device_unregistered')
    // The guest is isolated per pair, and the partition name is derived here so the
    // renderer never has to know how it is built.
    return {
      url: session.connections.entry(serviceId, pairId, generation),
      partition: peerPartition(serviceId, pairId)
    }
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

  async #removeNetworkAuthority(
    rpc: PeerChannel,
    serviceId: string,
    networkId: string
  ): Promise<void> {
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
    this.#sessions.clear('p2p.helper_unavailable')
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
