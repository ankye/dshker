import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '../../../src/shared/contracts'
import { PeerAccounts } from './accounts'
import { PeerCatalog } from './catalog'
import { PeerCredentialStore } from './credentials'
import type { PeerCatalogRecord } from './catalog-schema'
import { PeerEnrollment } from './enrollment'
import { PeerManagement } from './management'
import type { PeerMainHandler } from './rpc'
import type { PeerChannel } from './runtime-host'
import { PeerServices } from './services'
import { PeerHelperError } from './wire'

// This suite never invokes encryption; its separate two-process diagnostic uses
// the actual OS provider. Only the Electron module import is isolated here.
vi.mock('electron', () => ({ safeStorage: {} }))

const serviceId = 'a'.repeat(12)
const networkId = 'b'.repeat(12)
const otherNetworkId = 'c'.repeat(12)
const user = { userId: 'd'.repeat(12), username: 'owner' }
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
      if (method === 'pairs.list') return []
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
      handler!('catalog.changed', payload, new AbortController().signal)
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
  const deviceId = '3'.repeat(12)
  const publicKey = Buffer.alloc(32, 1).toString('base64')
  /** A second account the same machine can be bound to. */
  const secondAccount = { userId: 'f'.repeat(12), username: 'second@test.local' }
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

  /**
   * Presence is reported for one account, and a machine can be bound to several.
   * Reporting the account the credential was first issued for left a machine that
   * had been added to a second account invisible there while it was running, which
   * is the opposite of "the account you sign in on is the account it reports to".
   */
  it('reports presence to the account signed in here when the machine is bound to it', async () => {
    const f = fixture()
    enrolled()
    await signedInAsSecondAccount(f, [
      { deviceId, userId: secondAccount.userId, presence: 'online' }
    ])

    expect(deviceRestoreUser(f)).toBe(secondAccount.userId)
  })

  /**
   * The coordinator admits only an account the device is linked to, so naming one
   * it is not linked to would end the session. When the account's own list does
   * not carry this machine, the enrolled account stays in use.
   */
  it('keeps speaking as the enrolled account when the signed-in one has no such device', async () => {
    const f = fixture()
    enrolled()
    await signedInAsSecondAccount(f, [])

    expect(deviceRestoreUser(f)).toBe(user.userId)
  })

  /** The account named in the device identity handed to the core. */
  function deviceRestoreUser(f: ReturnType<typeof fixture>): string | undefined {
    const call = f.call.mock.calls.find(([method]) => method === 'device.restore')
    const payload = call?.[1] as { data?: { device?: { userId?: string } } } | undefined
    return payload?.data?.device?.userId
  }

  /**
   * Signs in as an account other than the one the credential was issued for, with
   * the core's directory for that account stubbed.
   */
  async function signedInAsSecondAccount(
    f: ReturnType<typeof fixture>,
    listed: { deviceId: string; userId: string; presence: string }[]
  ): Promise<void> {
    const base = f.call.getMockImplementation()
    f.call.mockImplementation(async (method: string, payload: unknown, signal: AbortSignal) => {
      if (method === 'user.login')
        return { user: secondAccount, token: '8'.repeat(64), expiresAt: futureExpiry() }
      if (method === 'user.current') return secondAccount
      // Which machines an account is bound to comes from the core's directory
      // now, and the presence decision asks the core to read the coordinator
      // rather than trust a snapshot that may not have been read yet.
      if (method === 'directory.inspect' || method === 'directory.refresh')
        return {
          serviceId,
          known: true,
          revision: 1,
          fetchedAt: 1789445714,
          networks: [],
          devices: listed.map((device) => ({
            name: 'This machine',
            lastSeen: 0,
            version: '',
            platform: '',
            architecture: '',
            ...device
          }))
        }
      if (base === undefined) throw new PeerHelperError('p2p.invalid_operation')
      return base(method, payload, signal)
    })
    await f.owner.login(
      serviceId,
      secondAccount.username,
      'test-password',
      new AbortController().signal
    )
    await f.owner.goOnline()
  }

  function futureExpiry(): number {
    return Math.floor(Date.now() / 1000) + 3600
  }

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

  it('recovers an offline service on the maintenance sweep', async () => {
    // A one-shot startup pass left a launcher offline for the rest of its run if
    // the coordinator was briefly unreachable. The sweep retries only what is
    // not already online.
    const f = fixture()
    await f.owner.goOnline()
    expect(await f.owner.serviceSessions()).toEqual([
      { serviceId, state: 'offline', code: 'p2p.device_unregistered' }
    ])
    enrolled()
    // A real short interval rather than fake timers: one sweep awaits catalog
    // inspection, runtime readiness, activation and restore, so advancing the
    // clock by one tick does not guarantee the sweep has finished.
    f.owner.startSessionMaintenance(10)
    await vi.waitFor(async () =>
      expect(await f.owner.serviceSessions()).toEqual([{ serviceId, state: 'online', code: '' }])
    )
  })

  it('notifies once per actual session change, not per sweep', async () => {
    const f = fixture()
    enrolled()
    const changed = vi.fn()
    f.owner.onSessionChange(changed)
    await f.owner.goOnline()
    expect(changed).toHaveBeenCalledTimes(1)
    // An online service is left alone, so repeated sweeps report nothing.
    f.owner.startSessionMaintenance(10)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(changed).toHaveBeenCalledTimes(1)
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

  it('answers the recorded pairs from the catalog without reading the coordinator', async () => {
    // The core reads the coordinator's pairs on its own maintenance loop, pins them
    // and records them, so rendering the pairing list must not put a coordinator
    // read back on the product. A row the core has recorded as revoked is no
    // longer an authorization, so it is not offered as a pair the menu can open.
    const f = fixture()
    f.record().computers.push({
      ...f.record().computers[0],
      connectionId: '9'.repeat(12),
      pairId: '9'.repeat(12),
      pairState: 'revoked'
    })
    const result = await f.owner.pairs(serviceId, new AbortController().signal)
    expect(result.map((pair) => pair.state)).toEqual(['active', 'active'])
    expect(result.map((pair) => pair.pairId)).toEqual(['2'.repeat(12), '6'.repeat(12)])
    // Nothing is asked of the core's channel: no session, no pairs.list, no pin.
    expect(f.call).not.toHaveBeenCalled()
    expect(f.attach).not.toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('refuses a pre-cancelled pairs read without touching the catalog', async () => {
    const f = fixture()
    await expect(f.owner.pairs(serviceId, AbortSignal.abort())).rejects.toMatchObject({
      code: 'p2p.request_cancelled'
    })
    expect(f.inspect).not.toHaveBeenCalled()
  })

  it('stays online when adoption is refused', async () => {
    // Adoption is an enhancement, not a precondition: a coordinator that rejects
    // it must not take the service offline.
    const f = fixture()
    enrolled()
    f.call.mockImplementation(async (method: string) => {
      if (method === 'pairs.adopt') throw new PeerHelperError('p2p.binding_unauthorized')
      if (method === 'device.restore') return { deviceId: '3'.repeat(12) }
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
    expect(f.attach).not.toHaveBeenCalled()
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
    expect(f.attach).not.toHaveBeenCalled()
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
    expect(f.detach).not.toHaveBeenCalled()
  })

  it('contains a failed core revocation without claiming the catalog was updated', async () => {
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
    expect(f.detach).toHaveBeenCalled()
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('does not restore core authority or close unrelated networks on a catalog write failure', async () => {
    const f = await loggedIn()
    f.commit.mockRejectedValueOnce(new PeerHelperError('p2p.catalog_write_failed'))
    await expect(
      f.owner.deleteNetwork(serviceId, networkId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.catalog_write_failed' })
    expect(f.call.mock.calls.filter(([method]) => method === 'network.invalidate')).toHaveLength(1)
    expect(f.detach).not.toHaveBeenCalled()
    expect(f.record().computers[1].pairState).toBe('active')
  })

  it('clears both account and enrollment owners on channel failure and does not reattach implicitly', async () => {
    const f = await loggedIn()
    f.unavailable()
    expect(f.clearAccounts).toHaveBeenCalledTimes(1)
    expect(f.clearEnrollment).toHaveBeenCalledTimes(1)
    await expect(
      f.owner.currentUser(serviceId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
    expect(f.attach).toHaveBeenCalledTimes(1)
  })

  it('announces the core directory revision to subscribers and stops when released', async () => {
    const f = await loggedIn()
    const seen: string[] = []
    const unsubscribe = f.owner.onDirectoryChange((changed) => seen.push(changed))
    expect(await f.directoryChanged({ serviceId, revision: 4 })).toEqual({})
    expect(seen).toEqual([serviceId])
    // A released subscriber is not told again: the push channel is the renderer's
    // only signal that a list it read is now stale.
    unsubscribe()
    await f.directoryChanged({ serviceId, revision: 5 })
    expect(seen).toEqual([serviceId])
  })

  /**
   * `p2p.pair_unauthorized` is final because retrying it is pointless — but it is
   * also what "the pin does not exist yet" looks like, and a pair refused in that
   * window was never attempted again whatever the core did afterwards, because
   * only a change of the machine's own network state cleared the refusals. The
   * core announces a new catalog revision exactly when it has re-derived the pairs
   * and their pins, so that announcement is the signal to try once more.
   */
  it('retries a pair refused before its pin existed, once the core announces a catalog revision', async () => {
    const f = await loggedIn()
    // A paired machine is an enrolled one: the attempt goes through the device
    // session before it can name a pair at all.
    const credential = {
      serviceId,
      deviceId: '3'.repeat(12),
      userId: user.userId,
      name: 'This machine',
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      certificate: 'test-only-credential-boundary',
      privateKey: Buffer.alloc(32, 9).toString('base64')
    }
    vi.spyOn(PeerCredentialStore.prototype, 'load').mockResolvedValue({
      revision: 'a'.repeat(64),
      credential
    } as Awaited<ReturnType<PeerCredentialStore['load']>>)
    vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockResolvedValue({
      kind: 'registered',
      revision: 'a'.repeat(64),
      credential
    } as Awaited<ReturnType<PeerCredentialStore['loadRegistration']>>)
    const base = f.call.getMockImplementation()
    // Both computers in the fixture are active, so attempts are counted per pair.
    const attempts = new Map<string, number>()
    f.call.mockImplementation(async (method: string, payload: unknown, signal: AbortSignal) => {
      if (method === 'peer.connect') {
        const pairId = (payload as { data?: { pairId?: string } }).data?.pairId ?? ''
        attempts.set(pairId, (attempts.get(pairId) ?? 0) + 1)
        throw new PeerHelperError('p2p.pair_unauthorized')
      }
      return base!(method, payload, signal)
    })
    // A network change is the one trigger that clears refusals today, so it is
    // what establishes the first attempt and its terminal refusal.
    f.owner.resumeConnectivity()
    const pairId = '2'.repeat(12)
    await vi.waitFor(() => expect(attempts.get(pairId)).toBe(1))
    // The refusal is final: the backoff that would retry within a second is not
    // scheduled at all.
    await new Promise((resolve) => setTimeout(resolve, 1400))
    expect(attempts.get(pairId)).toBe(1)
    await f.catalogChanged({ serviceId, revision: 'c'.repeat(64) })
    await vi.waitFor(() => expect(attempts.get(pairId)).toBe(2))
  })

  it('announces the core catalog revision to subscribers and stops when released', async () => {
    const f = await loggedIn()
    const seen: { serviceId: string; revision: string }[] = []
    const unsubscribe = f.owner.onCatalogChange((changedServiceId, revision) =>
      seen.push({ serviceId: changedServiceId, revision })
    )
    expect(await f.catalogChanged({ serviceId, revision: 'a'.repeat(64) })).toEqual({})
    expect(seen).toEqual([{ serviceId, revision: 'a'.repeat(64) }])
    // A released subscriber is not told again: the push channel is the only signal
    // that the paired computers the renderer listed are no longer the core's.
    unsubscribe()
    await f.catalogChanged({ serviceId, revision: 'b'.repeat(64) })
    expect(seen).toEqual([{ serviceId, revision: 'a'.repeat(64) }])
  })

  it('projects the core directory and marks this machine from the registered credential', async () => {
    // `isLocal` is the one part of the view the core cannot supply: it comes from
    // the credential main registered, so the renderer can refuse to let a user
    // remove the machine they are sitting at. The cached read answers from the
    // snapshot the core already holds; the refresh is the one read that makes the
    // core ask the coordinator again. The old account-devices op forced that read
    // on every Connect-page mount, which reported a bound machine as foreign when
    // the directory had not been read yet; that op is gone with the forced read.
    const f = await loggedIn()
    const deviceId = '3'.repeat(12)
    const base = f.call.getMockImplementation()
    vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockResolvedValue({
      kind: 'registered',
      revision: 'a'.repeat(64),
      credential: {
        serviceId,
        deviceId,
        userId: user.userId,
        name: 'This machine',
        publicKey: Buffer.alloc(32, 1).toString('base64'),
        certificate: 'test-only-credential-boundary',
        privateKey: Buffer.alloc(32, 9).toString('base64')
      }
    } as Awaited<ReturnType<PeerCredentialStore['loadRegistration']>>)
    f.call.mockImplementation(async (method: string, payload: unknown, signal: AbortSignal) => {
      if (method === 'directory.refresh' || method === 'directory.inspect')
        return {
          serviceId,
          known: true,
          revision: 2,
          fetchedAt: 1789445714,
          networks: [],
          devices: [
            {
              deviceId,
              userId: user.userId,
              name: 'This machine',
              presence: 'online',
              lastSeen: 0,
              version: '',
              platform: '',
              architecture: ''
            }
          ]
        }
      if (base === undefined) throw new PeerHelperError('p2p.invalid_operation')
      return base(method, payload, signal)
    })
    const cached = await f.owner.directory(serviceId, new AbortController().signal)
    expect(cached.devices.map((device) => device.deviceId)).toEqual([deviceId])
    // The credential, not the reply, decides which row is this computer.
    expect(cached.devices[0]?.isLocal).toBe(true)
    const refreshed = await f.owner.refreshDirectory(serviceId, new AbortController().signal)
    expect(refreshed.known).toBe(true)
    const methods = f.call.mock.calls.map(([method]) => method)
    expect(methods.filter((method) => method.startsWith('directory.'))).toEqual([
      'directory.inspect',
      'directory.refresh'
    ])
    expect(methods).not.toContain('devices.list')
  })

  describe('removing a configured service', () => {
    it('forgets the identity, drops its computers and commits once without touching the channel', async () => {
      const f = fixture()
      const result = await f.owner.removeService(serviceId, new AbortController().signal)
      expect(result.record.services).toHaveLength(0)
      expect(result.record.computers).toHaveLength(0)
      expect(result.record.forgottenServiceIds).toEqual([serviceId])
      expect(f.removeService).toHaveBeenCalledTimes(1)
      // Purely local: no RPC traffic at all.
      expect(f.attach).not.toHaveBeenCalled()
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
        f.owner.removeService('b'.repeat(12), new AbortController().signal)
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
