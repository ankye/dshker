import { APP_METADATA } from '../../../src/shared/contracts'
import type { PeerRpc } from './rpc'
import { PeerCatalog, type PeerCatalogSnapshot } from './catalog'
import { assertPeerEndpoints, parsePeerService, type PeerServiceRecord } from './catalog-schema'
import { assertAccountId, assertAccountText } from './account-records'
import { exactPeerObject, PeerHelperError } from './wire'

export interface PeerServiceInput {
  displayName: string
  httpsOrigin: string
  wssUrl: string
  stunAddress: string
}

/**
 * What this build reports about itself to a coordinator.
 *
 * The launcher owns its version string, so it is supplied to the helper on every
 * configure rather than guessed there. The coordinator displays these values in
 * its device directory and never uses them for authorization.
 *
 * The version comes from APP_METADATA, the same source the updater compares
 * against, rather than from the Electron runtime: it is the product's own
 * version either way, and this keeps the value available without a live app.
 */
export function launcherTelemetry(): { version: string; platform: string; architecture: string } {
  return {
    version: APP_METADATA.version,
    platform: process.platform,
    architecture: process.arch
  }
}

/** Owns the catalog-to-helper trust boundary; never accepts caller-supplied keys. */
export class PeerServices {
  readonly #active = new Map<string, string>()
  readonly #activating = new Set<string>()
  #adding = false
  #closed = false

  constructor(
    private readonly catalog: PeerCatalog,
    private readonly rpc: Pick<PeerRpc, 'call'>
  ) {}

  close(): void {
    this.#closed = true
    this.#active.clear()
  }

  async add(
    expectedRevision: string,
    input: PeerServiceInput,
    signal: AbortSignal
  ): Promise<PeerCatalogSnapshot> {
    assertAccountId(expectedRevision, 64)
    // Snapshot before the first await: renderer drafts cannot mutate this request.
    const fields = parseInput(input)
    this.#admit(signal)
    if (this.#adding) throw new PeerHelperError('p2p.service_busy')
    this.#adding = true
    try {
      const snapshot = await this.#snapshot()
      if (snapshot.revision !== expectedRevision) throw new PeerHelperError('p2p.catalog_conflict')
      if (snapshot.record.services.some((value) => value.httpsOrigin === fields.httpsOrigin))
        throw new PeerHelperError('p2p.service_exists')
      this.#admit(signal)
      const identity = await this.rpc.call(
        'service.configure',
        { endpoints: endpoints(fields), pinnedKey: '', telemetry: launcherTelemetry() },
        signal
      )
      this.#admit(signal)
      const service = verifiedService(identity, fields)
      if (snapshot.record.forgottenServiceIds.includes(service.serviceId))
        throw new PeerHelperError('p2p.trust_restore_rejected')
      if (snapshot.record.services.some((value) => value.serviceId === service.serviceId))
        throw new PeerHelperError('p2p.service_exists')
      const saved = await this.catalog.commit(expectedRevision, {
        ...snapshot.record,
        services: [...snapshot.record.services, service]
      })
      // A failed catalog write never grants account admission through this registry.
      this.#active.set(service.serviceId, serviceBinding(service))
      return saved
    } finally {
      this.#adding = false
    }
  }

  /**
   * Updates the shared endpoints of one already-verified service.
   *
   * This configuration is shared by every computer paired through the service,
   * so the whole affected set must be idle: if any of them is mid-operation the
   * update is refused rather than applied underneath it. The new address must
   * still prove the same pinned service identity, so pointing a record at a
   * different server is rejected instead of silently re-trusting it.
   *
   * On any failure the stored configuration is left exactly as it was and no
   * reconnect is attempted.
   */
  async updateConfig(
    expectedRevision: string,
    serviceId: string,
    input: PeerServiceInput,
    isComputerBusy: (connectionId: string) => boolean,
    signal: AbortSignal
  ): Promise<PeerCatalogSnapshot> {
    assertAccountId(expectedRevision, 64)
    assertAccountId(serviceId, 64)
    // Snapshot before the first await: renderer drafts cannot mutate this request.
    const fields = parseInput(input)
    this.#admit(signal)
    if (this.#adding || this.#activating.has(serviceId))
      throw new PeerHelperError('p2p.service_busy')
    this.#adding = true
    try {
      const snapshot = await this.#snapshot()
      if (snapshot.revision !== expectedRevision) throw new PeerHelperError('p2p.catalog_conflict')
      const existing = snapshot.record.services.find((value) => value.serviceId === serviceId)
      if (!existing) throw new PeerHelperError('p2p.service_not_found')
      if (snapshot.record.forgottenServiceIds.includes(serviceId))
        throw new PeerHelperError('p2p.trust_restore_rejected')
      // Another service must not be given this service's address.
      if (
        snapshot.record.services.some(
          (value) => value.serviceId !== serviceId && value.httpsOrigin === fields.httpsOrigin
        )
      )
        throw new PeerHelperError('p2p.service_exists')
      // Every computer sharing this configuration must be idle.
      const affected = snapshot.record.computers.filter(
        (computer) => computer.serviceId === serviceId
      )
      if (affected.some((computer) => isComputerBusy(computer.connectionId)))
        throw new PeerHelperError('p2p.service_busy')
      this.#admit(signal)
      const identity = await this.rpc.call(
        'service.configure',
        {
          endpoints: endpoints(fields),
          pinnedKey: existing.publicKey,
          telemetry: launcherTelemetry()
        },
        signal
      )
      this.#admit(signal)
      const verified = verifiedService(identity, fields)
      // The new endpoint must still be the same pinned identity.
      if (verified.serviceId !== serviceId || verified.publicKey !== existing.publicKey)
        throw new PeerHelperError('p2p.identity_mismatch')
      const services = snapshot.record.services.map((value) =>
        value.serviceId === serviceId ? verified : value
      )
      const saved = await this.catalog.commit(expectedRevision, {
        ...snapshot.record,
        services
      })
      // Rebind so later admission uses the new endpoints, never the stale ones.
      this.#active.delete(serviceId)
      return saved
    } finally {
      this.#adding = false
    }
  }

  /** Drops the live helper binding once a service is removed from the catalog. */
  forget(serviceId: string): void {
    this.#active.delete(serviceId)
  }

  async activate(serviceId: string, signal: AbortSignal): Promise<PeerServiceRecord> {
    assertAccountId(serviceId, 64)
    this.#admit(signal)
    if (this.#activating.has(serviceId)) throw new PeerHelperError('p2p.service_busy')
    this.#activating.add(serviceId)
    try {
      const service = await this.requireSaved(serviceId)
      this.#admit(signal)
      if (this.#active.get(serviceId) === serviceBinding(service)) return service
      const identity = await this.rpc.call(
        'service.configure',
        {
          endpoints: endpoints(service),
          pinnedKey: service.publicKey,
          telemetry: launcherTelemetry()
        },
        signal
      )
      this.#admit(signal)
      const verified = verifiedService(identity, service)
      if (verified.serviceId !== serviceId || verified.publicKey !== service.publicKey)
        throw new PeerHelperError('p2p.identity_mismatch')
      const current = await this.requireSaved(serviceId)
      this.#admit(signal)
      if (serviceBinding(current) !== serviceBinding(service))
        throw new PeerHelperError('p2p.catalog_conflict')
      this.#active.set(serviceId, serviceBinding(current))
      return current
    } finally {
      this.#activating.delete(serviceId)
    }
  }

  async requireSaved(serviceId: string): Promise<PeerServiceRecord> {
    assertAccountId(serviceId, 64)
    const { record } = await this.#snapshot()
    if (record.forgottenServiceIds.includes(serviceId))
      throw new PeerHelperError('p2p.trust_restore_rejected')
    const service = record.services.find((value) => value.serviceId === serviceId)
    if (!service) throw new PeerHelperError('p2p.service_unconfigured')
    return service
  }

  async #snapshot(): Promise<PeerCatalogSnapshot> {
    if (this.#closed) throw new PeerHelperError('p2p.helper_unavailable')
    const snapshot = await this.catalog.inspect()
    if (this.#closed) throw new PeerHelperError('p2p.helper_unavailable')
    if (!snapshot) throw new PeerHelperError('p2p.not_enabled')
    return snapshot
  }

  #admit(signal: AbortSignal): void {
    if (this.#closed) throw new PeerHelperError('p2p.helper_unavailable')
    if (signal.aborted) throw new PeerHelperError('p2p.request_cancelled')
  }
}

function parseInput(input: unknown): PeerServiceInput {
  const fields = exactPeerObject(input, ['displayName', 'httpsOrigin', 'wssUrl', 'stunAddress'])
  assertAccountText(fields.displayName)
  for (const field of ['httpsOrigin', 'wssUrl', 'stunAddress']) {
    if (typeof fields[field] !== 'string') throw new PeerHelperError('p2p.invalid_request')
  }
  const record = fields as unknown as PeerServiceInput
  assertPeerEndpoints(record.httpsOrigin, record.wssUrl, record.stunAddress)
  return { ...record }
}

function endpoints(value: PeerServiceInput) {
  return { httpsOrigin: value.httpsOrigin, wssUrl: value.wssUrl, stunAddress: value.stunAddress }
}

function serviceBinding(value: PeerServiceRecord): string {
  return JSON.stringify([
    value.serviceId,
    value.publicKey,
    value.httpsOrigin,
    value.wssUrl,
    value.stunAddress
  ])
}

function verifiedService(value: unknown, input: PeerServiceInput): PeerServiceRecord {
  const record = exactPeerObject(value, [
    'version',
    'serviceId',
    'publicKey',
    'certificate',
    'nonce',
    'httpsOrigin',
    'wssUrl',
    'stunAddress',
    'signature'
  ])
  if (
    record.version !== 1 ||
    record.httpsOrigin !== input.httpsOrigin ||
    record.wssUrl !== input.wssUrl ||
    record.stunAddress !== input.stunAddress
  )
    throw new PeerHelperError('p2p.identity_mismatch')
  assertAccountId(record.nonce)
  if (
    typeof record.signature !== 'string' ||
    Buffer.from(record.signature, 'base64url').length !== 64 ||
    Buffer.from(record.signature, 'base64url').toString('base64url') !== record.signature
  )
    throw new PeerHelperError('p2p.identity_mismatch')
  // Cryptographic challenge verification is performed by the authenticated Go
  // helper. Main independently validates the persisted CA/key and endpoint shape.
  return parsePeerService({
    ...input,
    serviceId: record.serviceId,
    publicKey: record.publicKey,
    certificate: record.certificate
  })
}
