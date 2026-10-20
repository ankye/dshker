import { afterEach, vi } from 'vitest'
import type { LauncherHarnessState } from '../../../../src/shared/contracts'
import { PeerAccounts } from '../accounts'
import { PeerCatalog } from '../catalog'
import { PeerCredentialStore } from '../credentials'
import type { PeerCatalogRecord } from '../catalog-schema'
import { PeerEnrollment } from '../enrollment'
import { PeerManagement } from '../management'
import type { PeerMainHandler } from '../rpc'
import type { PeerChannel } from '../runtime-host'
import { PeerServices } from '../services'
import { PeerHelperError } from '../wire'

export const serviceId = 'a'.repeat(12)
export const networkId = 'b'.repeat(12)
export const otherNetworkId = 'c'.repeat(12)
export const user = { userId: 'd'.repeat(12), username: 'owner' }
const owners: PeerManagement[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  vi.restoreAllMocks()
})

export function fixture() {
  const publicKey = Buffer.alloc(32, 1).toString('base64')
  const service = {
    serviceId,
    displayName: 'Server',
    httpsOrigin: 'https://example.test',
    wssUrl: 'wss://example.test/v1/signals',
    stunAddress: 'example.test:3478',
    publicKey,
    certificate: 'test-only-catalog-boundary'
  }
  const computer = {
    connectionId: '1'.repeat(12),
    serviceId,
    displayName: 'Remote',
    pairId: '2'.repeat(12),
    networkId,
    localDeviceId: '3'.repeat(12),
    remoteDeviceId: '4'.repeat(12),
    userId: user.userId,
    localPublicKey: publicKey,
    remotePublicKey: Buffer.alloc(32, 2).toString('base64'),
    pairRevision: 1,
    pairState: 'active' as const
  }
  let record: PeerCatalogRecord = {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: 'e'.repeat(12),
    services: [service],
    computers: [
      computer,
      {
        ...computer,
        connectionId: '5'.repeat(12),
        pairId: '6'.repeat(12),
        networkId: otherNetworkId
      }
    ],
    forgottenServiceIds: []
  }
  let networks = [
    { networkId, userId: user.userId, name: 'Work', maxDevices: 10 },
    { networkId: otherNetworkId, userId: user.userId, name: 'Other', maxDevices: 10 }
  ]
  const inspect = vi.spyOn(PeerCatalog.prototype, 'inspect').mockImplementation(async () => ({
    revision: 'f'.repeat(64),
    record: structuredClone(record)
  }))
  const commit = vi
    .spyOn(PeerCatalog.prototype, 'commit')
    .mockImplementation(async (_revision, next) => {
      record = structuredClone(next)
      return { revision: '7'.repeat(64), record: structuredClone(record) }
    })
  const removeService = vi
    .spyOn(PeerCatalog.prototype, 'removeService')
    .mockImplementation(async (serviceIdToDrop) => {
      // Mirror the real tolerant-removal validation so its business rules hold.
      if (record.forgottenServiceIds.includes(serviceIdToDrop))
        throw new PeerHelperError('p2p.trust_restore_rejected')
      if (!record.services.some((value) => value.serviceId === serviceIdToDrop))
        throw new PeerHelperError('p2p.service_not_found')
      record = {
        ...record,
        services: record.services.filter((value) => value.serviceId !== serviceIdToDrop),
        computers: record.computers.filter((value) => value.serviceId !== serviceIdToDrop),
        forgottenServiceIds: [...record.forgottenServiceIds, serviceIdToDrop]
      }
      return { revision: '9'.repeat(64), record: structuredClone(record) }
    })
  const activate = vi.spyOn(PeerServices.prototype, 'activate').mockResolvedValue(service)
  const clearAccounts = vi.spyOn(PeerAccounts.prototype, 'close')
  const clearEnrollment = vi.spyOn(PeerEnrollment.prototype, 'close')
  const attach = vi.fn()
  const detach = vi.fn()
  let unavailable: () => void = () => undefined
  /*
   * The codes the core's engine treats as final. Mirrored here only so this fake
   * core stops retrying the way the real one does; the authoritative set lives in
   * `networking/internal/autoconnect`.
   */
  const TERMINAL_REFUSALS = new Set([
    'p2p.not_enabled',
    'p2p.pair_unauthorized',
    'p2p.network_revoked',
    'p2p.pair_revoked',
    'p2p.pair_not_found',
    'p2p.identity_mismatch',
    'p2p.trust_restore_rejected',
    'p2p.lease_rejected',
    'p2p.device_revoked',
    'p2p.unauthorized'
  ])
  const refused = new Set<string>()
  const call = vi.fn(
    async (method: string, _payload: unknown, _signal: AbortSignal): Promise<unknown> => {
      if (method === 'user.login')
        return { user, token: '8'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 3600 }
      if (method === 'user.current') return user
      if (method === 'networks.list') return structuredClone(networks)
      if (method === 'networks.delete') {
        networks = networks.filter((network) => network.networkId !== networkId)
        return {}
      }
      if (method === 'network.invalidate') return {}
      // Restoring the enrolled device is what holds the signal connection the
      // coordinator heartbeat rides on.
      if (method === 'device.restore') return { deviceId: '3'.repeat(12) }
      if (method === 'device.certificate') {
        const { device } = (_payload as { data: { device: Record<string, unknown> } }).data
        return {
          deviceId: device.deviceId,
          publicKey: device.publicKey,
          certificate: device.certificate
        }
      }
      if (method === 'pairs.list') return []
      /*
       * Reconnection now lives in the core, so this fake core has to behave like
       * one: maintenance connects active pairs while preserving terminal intent.
       * Without this the shell's forwarding would be untestable here — the calls
       * would succeed and nothing would ever connect, which is exactly how the
       * behavior could silently disappear.
       */
      if (method === 'peer.autoconnect_reconcile' || method === 'peer.autoconnect_retry_now') {
        const scopedService = (_payload as { serviceId?: string }).serviceId ?? ''
        for (const computer of record.computers) {
          if (computer.serviceId !== scopedService) continue
          if (computer.pairState !== 'active') continue
          const identifier = computer.serviceId + ':' + computer.pairId
          if (refused.has(identifier)) continue
          try {
            await call(
              'peer.connect',
              { serviceId: computer.serviceId, data: { pairId: computer.pairId, generation: 1 } },
              _signal
            )
          } catch (error) {
            // The real engine stops retrying a pair whose authorization is gone.
            if (error instanceof PeerHelperError && TERMINAL_REFUSALS.has(error.code)) {
              refused.add(identifier)
            }
          }
        }
        return {}
      }
      throw new PeerHelperError('p2p.invalid_operation')
    }
  )
  // The core's channel, shared with the catalog and the secret store.
  let handler: PeerMainHandler | undefined
  const channel: PeerChannel = {
    call,
    serve: (value) => {
      attach()
      handler = value
      return () => {
        detach()
        if (handler === value) handler = undefined
      }
    },
    observe: (observer: (error: PeerHelperError) => void) => {
      unavailable = () => observer(new PeerHelperError('p2p.helper_unavailable'))
      return () => {
        unavailable = () => undefined
      }
    }
  }
  const runtimeStart = vi.fn(async () => ({ launch: { kind: 'stopped' } }) as LauncherHarnessState)
  // The fixture has no on-disk settings root. Model the explicit first-run
  // state for persisted user sessions; individual restore tests override this
  // spy with a durable token instead of relying on a missing test directory.
  vi.spyOn(PeerCredentialStore.prototype, 'loadUserSession').mockResolvedValue(undefined)
  vi.spyOn(PeerCredentialStore.prototype, 'saveUserSession').mockResolvedValue(undefined)
  vi.spyOn(PeerCredentialStore.prototype, 'load').mockRejectedValue(
    new PeerHelperError('p2p.credential_unavailable')
  )
  vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockRejectedValue(
    new PeerHelperError('p2p.credential_unavailable')
  )
  const owner = new PeerManagement({
    channel,
    resolveSettingsRoot: async () => '/test-owned-settings',
    runtime: {
      getRuntimeState: () => ({ kind: 'stopped' }),
      onRuntimeState: () => () => undefined,
      start: runtimeStart
    }
  })
  owners.push(owner)
  return {
    owner,
    call,
    attach,
    detach,
    commit,
    inspect,
    removeService,
    activate,
    clearAccounts,
    clearEnrollment,
    runtimeStart,
    record: () => record,
    unavailable: () => unavailable(),
    directoryChanged: (payload: unknown) =>
      handler!('directory.changed', payload, new AbortController().signal),
    catalogChanged: (payload: unknown) =>
      handler!('catalog.changed', payload, new AbortController().signal),
    // The core announces every connection stage through this callback, which is how
    // the shell learns a session it did not start has changed.
    peerStage: (payload: unknown) => handler!('peer.state', payload, new AbortController().signal)
  }
}
