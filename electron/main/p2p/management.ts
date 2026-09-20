import { hostname } from 'node:os'
import type { LauncherHarnessService } from '../managed/launcher-harness-service'
import { assertAccountId } from './account-records'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { peerPartition } from './partitions'
import { PeerConnections } from './connections'
import { PeerCredentialStore } from './credentials'
import { PeerDeviceViews } from './device-views'
import { PeerEnrollment } from './enrollment'
import { enrollWhenMissing } from './enrollment-bootstrap'
import { PeerPairing } from './pairing'
import { PeerRemoteProjects } from './remote-projects'
import { PeerRuntimeHost, type PeerChannel } from './runtime-host'
import { diagnoseShellFailure, PeerSessionRegistry, restoreUserSession } from './session-registry'
import { P2PSelectionStore } from './selection-preferences'
import { PeerServices, type PeerServiceInput } from './services'
import { exactPeerObject, PeerHelperError } from './wire'
import { memberAsPair } from './management-projection'
import { CoreAutoConnect } from './auto-connect'
import type { CoreCatalogPort } from '../core/catalog'
import type { CoreSecretPort } from '../core/secrets'

interface Options {
  /** The core's private channel. Absent when the shell could not start a core. */
  channel?: PeerChannel
  resolveSettingsRoot(): Promise<string>
  secrets?: CoreSecretPort
  catalog?: CoreCatalogPort
  runtime: Pick<LauncherHarnessService, 'getRuntimeState' | 'onRuntimeState' | 'start'>
  /**
   * Reads the local workspace root directories that a connected peer is
   * authorised to browse. When absent or returning an empty list the peer is
   * told "no authorised directories" rather than seeing a connection failure.
   */
  rootsProvider?(): Promise<{ rootId: string; name: string; path: string }[]>
}

interface Session {
  rpc: PeerChannel
  /** Drives the core's reconnection engine; the shell keeps no copy of it. */
  autoConnect: CoreAutoConnect
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
  /** One persisted-account restore at a time per coordinator service. */
  readonly #restoreInFlight = new Map<string, Promise<void>>()
  /**
   * This computer's session with each coordinator.
   *
   * The network layer, kept separate from a pair connection, which the runtime host
   * tracks: this is "am I online with the coordinator?", not "is one peer's
   * workbench reachable?".
   */
  readonly #sessions = new PeerSessionRegistry()
  #sessionSweep: ReturnType<typeof setInterval> | undefined
  readonly #resolveSettingsRoot: () => Promise<string>
  readonly #selection: P2PSelectionStore
  /** The device directories the renderer reads, so the local marker has one source. */
  readonly #devices: PeerDeviceViews
  /**
   * Listeners told when the core announces a new directory revision.
   *
   * The core owns the snapshot and reads the coordinator on its own, so a page
   * that already rendered a list has to be told rather than left to poll.
   */
  readonly #directoryListeners = new Set<(serviceId: string) => void>()
  /**
   * Listeners told when the core announces a new catalog revision.
   *
   * The paired computers are the core's now: it re-reads the coordinator's pairs
   * on its own maintenance loop and pins them, so nothing the shell renders can
   * learn that a computer appeared or went away unless it is told.
   */
  readonly #catalogListeners = new Set<(serviceId: string, revision: string) => void>()

  constructor(options: Options) {
    this.#resolveSettingsRoot = options.resolveSettingsRoot
    this.#selection = new P2PSelectionStore({ resolveSettingsRoot: options.resolveSettingsRoot })
    this.#catalog = new PeerCatalog(options.resolveSettingsRoot, options.catalog)
    this.#credentials = new PeerCredentialStore(options.resolveSettingsRoot, options.secrets)
    this.#devices = new PeerDeviceViews(
      (serviceId, signal, operation) => this.#account(serviceId, signal, operation),
      async (serviceId) => {
        // A service with no registration yet simply has no local device in the list.
        const saved = await this.#credentials.loadRegistration(serviceId).catch(() => undefined)
        return saved?.kind === 'registered' ? saved.credential.deviceId : ''
      }
    )
    this.#host = new PeerRuntimeHost({
      channel: options.channel,
      catalog: this.#catalog,
      runtime: options.runtime,
      rootsProvider: options.rootsProvider,
      onUnavailable: () => this.#clearSession(),
      // A drop is retried at once rather than at the next sweep: the hole is
      // usually re-punchable within a second of a network change, and a tab the
      // user may switch back to at any moment must not sit dead in between.
      onPeerStage: (serviceId, pairId, stage, generation) => {
        // The core can replace an attempt without this process calling connect, so
        // the address cached under the old one must go. See `retire`.
        this.#session?.connections.retire(serviceId, pairId, generation)
        if (stage === 'disconnected' || stage === 'failed') void this.#reconcile(serviceId)
      },
      // The core announces a directory revision instead of the shell discovering
      // one: the snapshot is the core's, and a page that already read it cannot
      // see a new device list otherwise.
      onDirectoryChange: (serviceId) => {
        for (const listener of this.#directoryListeners) listener(serviceId)
      },
      // The core announces a catalog revision for the same reason: it owns the
      // paired computers, so a Run menu that already listed them cannot see a
      // computer that was paired on another machine otherwise.
      onCatalogChange: (serviceId, revision) => {
        // A new revision means the core has just re-derived the pairs and their
        // pins, which is the one thing a terminal refusal was waiting for.
        // `p2p.pair_unauthorized` is treated as final because retrying it is
        // pointless — but it is also what a read that had not happened yet looks
        // like, and without this a pair refused in that window was never attempted
        // again, whatever the core did afterwards.
        void this.#session?.autoConnect.clearRefusals(serviceId)
        void this.#reconcile(serviceId)
        for (const listener of this.#catalogListeners) listener(serviceId, revision)
      }
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
    for (const result of results) if (result.online) void this.#reconcile(result.serviceId)
    return results
  }

  /**
   * Notifies when a session changes. See `PeerSessionRegistry`.
   */
  onSessionChange(listener: () => void): () => void {
    return this.#sessions.onSessionChange(listener)
  }

  /**
   * Notifies when the core's directory snapshot for a service moves.
   *
   * Separate from `onSessionChange` because the two answer different questions:
   * a session says whether this computer is online with the coordinator, while a
   * directory revision says whether the device list it already rendered is still
   * the core's.
   */
  onDirectoryChange(listener: (serviceId: string) => void): () => void {
    this.#directoryListeners.add(listener)
    return () => {
      this.#directoryListeners.delete(listener)
    }
  }

  /**
   * Notifies when the core's paired-computer catalog for a service moves.
   *
   * Separate from `onDirectoryChange` because the two describe different lists: a
   * directory revision says the coordinator's device list changed, while a catalog
   * revision says which computers are paired and authorized changed — a machine on
   * the network without a pair is in the first and not the second. The revision
   * travels with the service so a listener can ignore a repeat of a snapshot it
   * has already read.
   */
  onCatalogChange(listener: (serviceId: string, revision: string) => void): () => void {
    this.#catalogListeners.add(listener)
    return () => {
      this.#catalogListeners.delete(listener)
    }
  }

  /**
   * Re-establishes any service that is not currently online.
   *
   * A session is not self-healing: the coordinator can drop it, the network can
   * change, or the machine can wake from sleep, and nothing in the one-shot
   * startup pass would notice. Only services that are already offline are
   * retried, so an online service's session is never disturbed by the sweep.
   * Nothing else has to be re-synced here: the core re-reads the coordinator's
   * members on its own loop and announces the result.
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
    void this.#resumeEveryService()
    void this.#sweepSessions()
  }

  /**
   * Asks the core to bring one service's authorized pairs up to intent.
   *
   * Best effort by design: this runs from stage transitions and catalog revisions,
   * so a core with no session for the service yet must not turn a background sweep
   * into a failed operation. The engine is idempotent, and the next event or the
   * daemon's own periodic pass covers a skipped one.
   */
  async #reconcile(serviceId: string): Promise<void> {
    if (this.#lifetime.signal.aborted) return
    await this.#session?.autoConnect.reconcile(serviceId)
  }

  /**
   * Clears every backoff and retries every paired service now.
   *
   * Used when the machine itself changed state — network back, waking from sleep —
   * where waiting out the final delay would feel broken. The per-pair schedule stays
   * the core's; this only reports that the situation changed.
   */
  async #resumeEveryService(): Promise<void> {
    const session = this.#session
    if (session === undefined) return
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    for (const service of snapshot?.record.services ?? []) {
      if (this.#lifetime.signal.aborted) return
      await session.autoConnect.clearRefusals(service.serviceId)
      await session.autoConnect.retryNow(service.serviceId)
    }
  }

  async #sweepSessions(): Promise<void> {
    const snapshot = await this.#catalog.inspect().catch(() => undefined)
    if (!snapshot) return
    for (const service of snapshot.record.services) {
      if (this.#lifetime.signal.aborted) return
      // A session that stayed up needs nothing from this sweep: the catalog of
      // paired computers is the core's, and the core re-reads it on its own.
      if (this.#sessions.find(service.serviceId)?.state === 'online') continue
      try {
        await this.#readyAsDevice(service.serviceId, this.#lifetime.signal)
        this.#sessions.record(service.serviceId, 'online', '')
      } catch (error) {
        this.#sessions.record(service.serviceId, 'offline', this.#refusalCode(error))
      }
    }
    // The same sweep repairs pair connections: a drop that happened while the
    // coordinator session stayed up is retried here without any user action.
    for (const service of snapshot.record.services) await this.#reconcile(service.serviceId)
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

  /**
   * Discards a catalog this build cannot read and starts an empty one.
   *
   * The record is otherwise undroppable: every catalog operation re-validates it,
   * removal of a single service included. Nothing else is touched, and the
   * unreadable files are kept beside the new one.
   */
  async resetCatalog() {
    this.#admit()
    return this.#catalog.reset()
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
   * Read from the machine key, not minted here: an invented id looked like an
   * identifier but named a device nothing else had seen. Details in
   * `.agents/notes/2026-09-15-one-device-id-per-machine.md`.
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
    this.#restoreInFlight.delete(serviceId)
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
   * The core's cached directory for one coordinator.
   *
   * A read: it never makes the core read the coordinator again, so opening a
   * device list is not a network round trip of its own.
   */
  directory(serviceId: string, signal: AbortSignal) {
    return this.#devices.directory(serviceId, signal)
  }
  /** The core's directory after one more coordinator read. */
  refreshDirectory(serviceId: string, signal: AbortSignal) {
    return this.#devices.refreshDirectory(serviceId, signal)
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
    // The coordinator invalidates this device's pairs in the same transaction, and
    // the core's own maintenance pass records that as a revocation. Nothing here
    // re-reads it: the shell no longer holds a pairs read, and asking for one would
    // put a coordinator round trip back on a page action.
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
   * nothing restored the saved credential after enrollment, so those calls failed
   * with device_unregistered. Restoring is idempotent: the helper refusing a
   * second restore counts as restored.
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
              // Pins are the core's: its own catalog pass re-pins every active
              // pair into this session, so a restore hands over none.
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
    return session
  }

  /**
   * The account this machine reports presence for, out of the ones it belongs to.
   * Read after the persisted login is adopted; with nobody signed in, the
   * credential's own account stands. The coordinator admits only a linked account,
   * so the switch waits for its list to confirm the link.
   *
   * This one read asks the core to read the coordinator instead of answering from
   * its snapshot, because the snapshot is not necessarily read yet at restore
   * time — the core starts reading when it first sees the session token, which is
   * this same startup path — and a "nothing read yet" answer here would report the
   * credential's account and make the machine invisible to the account using it,
   * which is the bug this check exists to fix. It is the same single coordinator
   * read the old per-account `devices.list` performed.
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
      .refreshDirectory(serviceId, this.#signal(signal))
      .then((directory) =>
        directory.devices.some((device) => device.deviceId === credential.deviceId)
      )
      .catch(() => false)
    return linked ? signedIn : credential.userId
  }

  /**
   * Reuses the persisted login session so a restart does not ask for the
   * password again. Concurrent startup/account reads share one restore, and
   * only an authoritative server refusal drops the persisted token.
   */
  async #restoreUserSession(
    serviceId: string,
    session: Session,
    signal: AbortSignal
  ): Promise<void> {
    const existing = this.#restoreInFlight.get(serviceId)
    if (existing) return existing
    const pending = restoreUserSession(this.#credentials, session, serviceId, signal).finally(
      () => {
        if (this.#restoreInFlight.get(serviceId) === pending)
          this.#restoreInFlight.delete(serviceId)
      }
    )
    this.#restoreInFlight.set(serviceId, pending)
    return pending
  }

  /**
   * Lists paired computers as the pairing surface.
   *
   * Trust is a pair the coordinator has authorized, and that decision is already
   * recorded: the core reads the coordinator's pairs on its own maintenance loop,
   * pins them and writes the catalog, then announces the change. So this is a
   * read of the snapshot main already holds — no session is started and no
   * coordinator read is made, because a list a page happens to render must never
   * be the reason the machine talks to the server.
   */
  async pairs(serviceId: string, signal: AbortSignal) {
    this.#admit()
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
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
    const autoConnect = new CoreAutoConnect(rpc)
    // prettier-ignore
    this.#session = { rpc, autoConnect, services, accounts, enrollment, pairing, connections, projects }
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
    // so opening the panel does not demand the password again. A transient
    // restore failure must remain a typed loading/transport error; swallowing it
    // would make the following local `currentUser` call look like a sign-out.
    await this.#restoreUserSession(serviceId, session, active)
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
    this.#restoreInFlight.clear()
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
