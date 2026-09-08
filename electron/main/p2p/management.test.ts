import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
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
})
