import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { PeerCredentialStore } from './credentials'
import type { PeerCatalogRecord } from './catalog-schema'
import { PeerEnrollment } from './enrollment'
import { PeerManagement } from './management'
import { PeerServices } from './services'
import { PeerSupervisor, type PeerSupervisorOptions } from './supervisor'
import { PeerHelperError } from './wire'

// This suite never invokes encryption; its separate two-process diagnostic uses
// the actual OS provider. Only the Electron module import is isolated here.
vi.mock('electron', () => ({ safeStorage: {} }))

const serviceId = 'a'.repeat(64)
const networkId = 'b'.repeat(32)
const otherNetworkId = 'c'.repeat(32)
const user = { userId: 'd'.repeat(32), username: 'owner' }
const owners: PeerManagement[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  vi.restoreAllMocks()
})

function fixture() {
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
    connectionId: '1'.repeat(32),
    serviceId,
    displayName: 'Remote',
    pairId: '2'.repeat(32),
    networkId,
    localDeviceId: '3'.repeat(32),
    remoteDeviceId: '4'.repeat(32),
    userId: user.userId,
    localPublicKey: publicKey,
    remotePublicKey: Buffer.alloc(32, 2).toString('base64'),
    pairRevision: 1,
    pairState: 'active' as const
  }
  let record: PeerCatalogRecord = {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: 'e'.repeat(32),
    services: [service],
    computers: [
      computer,
      {
        ...computer,
        connectionId: '5'.repeat(32),
        pairId: '6'.repeat(32),
        networkId: otherNetworkId
      }
    ],
    forgottenServiceIds: []
  }
  let networks = [
    { networkId, userId: user.userId, name: 'Work', maxDevices: 10 },
    { networkId: otherNetworkId, userId: user.userId, name: 'Other', maxDevices: 10 }
  ]
  vi.spyOn(PeerCatalog.prototype, 'inspect').mockImplementation(async () => ({
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
  let unavailable!: PeerSupervisorOptions['onUnavailable']
  const close = vi.fn(async () => undefined)
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
      if (method === 'device.restore') return { deviceId: '3'.repeat(32) }
      if (method === 'pairs.list') return []
      throw new PeerHelperError('p2p.invalid_operation')
    }
  )
  const spawn = vi.spyOn(PeerSupervisor, 'start').mockImplementation(async (options) => {
    unavailable = options.onUnavailable
    return { rpc: { call }, close } as unknown as PeerSupervisor
  })
  const runtimeStart = vi.fn(async () => ({ launch: { kind: 'stopped' } }) as LauncherHarnessState)
  const owner = new PeerManagement({
    resourcesRoot: '/test-owned-resources',
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
    close,
    commit,
    removeService,
    spawn,
    activate,
    clearAccounts,
    clearEnrollment,
    runtimeStart,
    record: () => record,
    unavailable: () => unavailable(new PeerHelperError('p2p.helper_unavailable'))
  }
}

async function loggedIn() {
  const f = fixture()
  expect(
    await f.owner.login(serviceId, user.username, 'test-password', new AbortController().signal)
  ).toEqual(user)
  return f
}

describe('bringing enrolled services online at startup', () => {
  const deviceId = '3'.repeat(32)
  const publicKey = Buffer.alloc(32, 1).toString('base64')
  /** Makes this machine look like it completed enrollment for the saved service. */
  function enrolled() {
    vi.spyOn(PeerCredentialStore.prototype, 'load').mockResolvedValue({
      revision: 'a'.repeat(64),
      credential: {
        serviceId,
        deviceId,
        userId: user.userId,
        name: 'This machine',
        publicKey,
        certificate: 'test-only-credential-boundary',
        privateKey: Buffer.alloc(32, 9).toString('base64')
      }
    } as Awaited<ReturnType<PeerCredentialStore['load']>>)
    // Pairing resolves the local device through the registration readback, not
    // the credential itself.
    vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockResolvedValue({
      kind: 'registered',
      revision: 'a'.repeat(64),
      credential: {
        serviceId,
        deviceId,
        userId: user.userId,
        name: 'This machine',
        publicKey,
        certificate: 'test-only-credential-boundary',
        privateKey: Buffer.alloc(32, 9).toString('base64')
      }
    } as Awaited<ReturnType<PeerCredentialStore['loadRegistration']>>)
  }

  it('restores the device session so the coordinator heartbeat can run', async () => {
    // Presence, the reported build, discoverability and pairing all depend on
    // the heartbeat, which only runs while a device session holds the signal
    // connection. Nothing established it until the user opened pairing, so a
    // running launcher looked offline to every other machine.
    const f = fixture()
    enrolled()
    const results = await f.owner.goOnline()
    expect(results).toEqual([{ serviceId, online: true }])
    expect(f.call.mock.calls.map(([method]) => method)).toContain('device.restore')
  })

  it('stays offline for a service this machine never enrolled', async () => {
    // Without a saved credential there is no device to speak as, so the service
    // is reported offline rather than failing the whole startup pass.
    const f = fixture()
    expect(await f.owner.goOnline()).toEqual([
      { serviceId, online: false, code: 'p2p.device_unregistered' }
    ])
  })

  it('retains why a session is down so the surface can explain it', async () => {
    // The refusal used to be discarded, so the product could only say "offline"
    // and the cause was reachable only by inspecting files on disk.
    const f = fixture()
    await f.owner.goOnline()
    expect(await f.owner.serviceSessions()).toEqual([
      { serviceId, state: 'offline', code: 'p2p.device_unregistered' }
    ])
  })

  it('reports a confirmed session without a refusal code', async () => {
    const f = fixture()
    enrolled()
    await f.owner.goOnline()
    expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'online', code: '' }])
  })

  it('ends a recorded session when the runtime is lost', async () => {
    // A session that outlived its runtime would assert reach the computer no
    // longer has, which is worse than reporting nothing.
    const f = fixture()
    enrolled()
    await f.owner.goOnline()
    expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'online', code: '' }])
    f.unavailable()
    expect(await f.owner.serviceSessions()).toEqual([
      { serviceId, state: 'offline', code: 'p2p.helper_unavailable' }
    ])
  })

  it('reports an unattempted service as offline with no invented reason', async () => {
    // Never having tried is not a refusal, so no code is supplied for one.
    const f = fixture()
    expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'offline', code: '' }])
  })

  it('pairs devices that already share a network, with no invite', async () => {
    // Joining a network is the authorization. Without this, membership granted
    // nothing and two of the user's own machines still had to exchange a code.
    const f = fixture()
    enrolled()
    await f.owner.goOnline()
    expect(f.call.mock.calls.map(([method]) => method)).toContain('pairs.adopt')
  })

  it('stays online when adoption is refused', async () => {
    // Adoption is an enhancement, not a precondition: a coordinator that rejects
    // it must not take the service offline.
    const f = fixture()
    enrolled()
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pairs.adopt') throw new PeerHelperError('p2p.binding_unauthorized')
      if (method === 'device.restore') return { deviceId: '3'.repeat(32) }
      if (method === 'user.current') return user
      return {}
    })
    expect(await f.owner.goOnline()).toEqual([{ serviceId, online: true }])
  })

  it('reports a refusal per service instead of throwing', async () => {
    // An unreachable coordinator, a service that was never enrolled here, or a
    // revoked credential must leave the app usable and simply offline.
    const f = fixture()
    vi.spyOn(PeerServices.prototype, 'activate').mockRejectedValue(
      new PeerHelperError('p2p.helper_unavailable')
    )
    const results = await f.owner.goOnline()
    expect(results).toEqual([{ serviceId, online: false, code: 'p2p.helper_unavailable' }])
  })

  it('does nothing when P2P was never enabled', async () => {
    const f = fixture()
    vi.spyOn(PeerCatalog.prototype, 'inspect').mockResolvedValue(undefined)
    expect(await f.owner.goOnline()).toEqual([])
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('stops once the owner is closing rather than starting new work', async () => {
    const f = fixture()
    await f.owner.close()
    expect(await f.owner.goOnline()).toEqual([])
  })
})

describe('formal P2P management composition', () => {
  it('keeps construction idle and activates the saved service before account traffic', async () => {
    const f = fixture()
    expect(f.spawn).not.toHaveBeenCalled()
    await f.owner.login(serviceId, user.username, 'test-password', new AbortController().signal)
    expect(f.activate.mock.invocationCallOrder[0]).toBeLessThan(f.call.mock.invocationCallOrder[0])
    expect(f.runtimeStart).not.toHaveBeenCalled()
    expect(f.owner.status()).toEqual({ error: '', peers: [] })
  })

  it('revokes only the deleted network after server acknowledgement and reads the result back', async () => {
    const f = await loggedIn()
    f.call.mockClear()
    await f.owner.deleteNetwork(serviceId, networkId, new AbortController().signal)
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'networks.list',
      'networks.delete',
      'network.invalidate',
      'networks.list'
    ])
    expect(f.call.mock.calls[2][1]).toEqual({ serviceId, data: { networkId } })
    expect(f.record().computers.map(({ networkId: id, pairState }) => [id, pairState])).toEqual([
      [networkId, 'revoked'],
      [otherNetworkId, 'active']
    ])
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
  })

  it('contains a failed helper revocation without claiming the catalog was updated', async () => {
    const f = await loggedIn()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (...args) => {
      if (args[0] === 'network.invalidate') throw new PeerHelperError('p2p.request_timeout')
      return original(...args)
    })
    await expect(
      f.owner.deleteNetwork(serviceId, networkId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.request_timeout' })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.owner.status().error).toBe('p2p.authorization_cleanup_failed')
    expect(f.clearAccounts).toHaveBeenCalled()
    expect(f.clearEnrollment).toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('does not restore helper authority or close unrelated networks on a catalog write failure', async () => {
    const f = await loggedIn()
    f.commit.mockRejectedValueOnce(new PeerHelperError('p2p.catalog_write_failed'))
    await expect(
      f.owner.deleteNetwork(serviceId, networkId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.catalog_write_failed' })
    expect(f.call.mock.calls.filter(([method]) => method === 'network.invalidate')).toHaveLength(1)
    expect(f.close).not.toHaveBeenCalled()
    expect(f.record().computers[1].pairState).toBe('active')
  })

  it('clears both account and enrollment owners on helper failure and does not restart implicitly', async () => {
    const f = await loggedIn()
    f.unavailable()
    expect(f.clearAccounts).toHaveBeenCalledTimes(1)
    expect(f.clearEnrollment).toHaveBeenCalledTimes(1)
    await expect(
      f.owner.currentUser(serviceId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  describe('removing a configured service', () => {
    it('forgets the identity, drops its computers and commits once without starting the helper', async () => {
      const f = fixture()
      const result = await f.owner.removeService(serviceId, new AbortController().signal)
      expect(result.record.services).toHaveLength(0)
      expect(result.record.computers).toHaveLength(0)
      expect(result.record.forgottenServiceIds).toEqual([serviceId])
      expect(f.removeService).toHaveBeenCalledTimes(1)
      // Purely local: no helper process or RPC traffic.
      expect(f.spawn).not.toHaveBeenCalled()
      expect(f.call).not.toHaveBeenCalled()
      expect(f.runtimeStart).not.toHaveBeenCalled()
      // The catalog readback is exactly what a later projection would show.
      expect(f.record().services).toHaveLength(0)
    })

    it('never re-trusts an identity that was already forgotten', async () => {
      const f = fixture()
      await f.owner.removeService(serviceId, new AbortController().signal)
      await expect(
        f.owner.removeService(serviceId, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'p2p.trust_restore_rejected' })
      // The second call delegates to catalog.removeService, which refuses the
      // re-trust without writing; so it is reached twice (once to remove, once
      // to refuse) but the file is only changed by the first.
      expect(f.removeService).toHaveBeenCalledTimes(2)
    })

    it('refuses to remove an unknown service without touching the catalog', async () => {
      const f = fixture()
      await expect(
        f.owner.removeService('b'.repeat(64), new AbortController().signal)
      ).rejects.toMatchObject({ code: 'p2p.service_not_found' })
      expect(f.removeService).toHaveBeenCalledTimes(1)
      expect(f.record().services).toHaveLength(1)
    })

    it('surfaces a failed catalog write and keeps the removed service intact', async () => {
      const f = fixture()
      f.removeService.mockRejectedValueOnce(new PeerHelperError('p2p.catalog_write_failed'))
      await expect(
        f.owner.removeService(serviceId, new AbortController().signal)
      ).rejects.toMatchObject({ code: 'p2p.catalog_write_failed' })
      expect(f.record().services).toHaveLength(1)
      expect(f.record().computers).toHaveLength(2)
      expect(f.record().forgottenServiceIds).toHaveLength(0)
    })
  })
})
