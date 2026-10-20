import { describe, expect, it, vi } from 'vitest'
import type { PeerDirectory } from './account-records'
import { PeerCertificateRecoveryScope } from './certificate-recovery-scope'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const deviceId = 'b'.repeat(12)
const user = { userId: 'c'.repeat(12), username: 'network-owner' }
const networkId = 'd'.repeat(12)
const token = 'e'.repeat(64)

function fixture() {
  const controller = new AbortController()
  const remembered = vi.fn(
    async (_service: string, _user: string): Promise<string | undefined> => networkId
  )
  const directory: PeerDirectory = {
    known: true,
    revision: 1,
    fetchedAt: 1,
    networks: [
      {
        networkId,
        userId: user.userId,
        name: 'Explicitly selected network',
        maxDevices: 10,
        devices: [
          {
            deviceId,
            userId: 'f'.repeat(12),
            name: 'Original device',
            presence: 'offline',
            lastSeen: 0,
            version: '',
            platform: '',
            architecture: ''
          }
        ]
      }
    ],
    devices: []
  }
  const accounts = {
    hasSession: vi.fn(() => true),
    sessionToken: vi.fn((): string | undefined => token),
    currentUser: vi.fn(async () => ({ ...user })),
    refreshDirectory: vi.fn(async () => structuredClone(directory)),
    certificateRecoveryScope: vi.fn(async () => ({
      user: { ...user },
      networks: structuredClone(directory.networks)
    }))
  }
  const owner = new PeerCertificateRecoveryScope({ remembered })
  const assertLifecycle = vi.fn()
  const resolve = () =>
    owner.resolve(serviceId, deviceId, accounts, token, controller.signal, assertLifecycle)
  return { owner, resolve, remembered, accounts, directory, controller, assertLifecycle }
}

describe('legacy certificate recovery scope admission', () => {
  it('freshly verifies the current user and exact manual network with the original device', async () => {
    const f = fixture()
    const scope = await f.resolve()
    expect(f.accounts.certificateRecoveryScope).toHaveBeenCalledExactlyOnceWith(
      serviceId,
      deviceId,
      f.controller.signal
    )
    expect(f.remembered).toHaveBeenCalledWith(serviceId, user.userId)
    expect(f.accounts.currentUser).not.toHaveBeenCalled()
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.accounts.certificateRecoveryScope.mock.invocationCallOrder[0]).toBeLessThan(
      f.remembered.mock.invocationCallOrder[0]
    )
    expect(scope.networkId).toBe(networkId)
    // A different original enrollment owner does not revoke this account's network grant.
    expect(f.directory.networks[0].devices[0].userId).not.toBe(user.userId)
    await scope.recheck()
    expect(f.remembered).toHaveBeenCalledTimes(2)
    expect(() => scope.assertCurrent()).not.toThrow()
  })

  it('requires a manual selection even when the account has exactly one eligible network', async () => {
    const f = fixture()
    f.remembered.mockResolvedValue(undefined)
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.accounts.certificateRecoveryScope).toHaveBeenCalledOnce()
    expect(f.remembered).toHaveBeenCalledWith(serviceId, user.userId)
  })

  it('never reads another account selection using the original enrollment owner', async () => {
    const f = fixture()
    f.remembered.mockImplementation(async (_service, selectedUser) =>
      selectedUser === 'f'.repeat(12) ? networkId : undefined
    )
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(f.remembered).toHaveBeenCalledExactlyOnceWith(serviceId, user.userId)
  })

  it.each(['deleted', 'foreign', 'unbound'] as const)(
    'refuses a %s selected network without trying another',
    async (kind) => {
      const f = fixture()
      if (kind === 'deleted') f.directory.networks[0].networkId = '1'.repeat(12)
      if (kind === 'foreign') f.directory.networks[0].userId = '2'.repeat(12)
      if (kind === 'unbound') f.directory.networks[0].devices[0].deviceId = '3'.repeat(12)
      await expect(f.resolve()).rejects.toMatchObject({
        code: 'p2p.certificate_recovery_forbidden'
      })
      expect(f.remembered).toHaveBeenCalledOnce()
    }
  )

  it('refuses an empty fresh network list instead of reusing a cached directory', async () => {
    const f = fixture()
    f.directory.networks = []
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_forbidden' })
  })

  it('keeps malformed and unavailable directory failures explicit', async () => {
    const f = fixture()
    f.accounts.certificateRecoveryScope.mockRejectedValueOnce(
      new PeerHelperError('p2p.invalid_server_response')
    )
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
    f.accounts.certificateRecoveryScope.mockRejectedValueOnce(
      new PeerHelperError('p2p.server_unavailable')
    )
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.server_unavailable' })
  })

  it('refuses duplicate selected networks rather than using the first match', async () => {
    const f = fixture()
    f.directory.networks.push(structuredClone(f.directory.networks[0]))
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.invalid_server_response' })
  })

  it('reports unreadable manual selection storage without inferring scope', async () => {
    const f = fixture()
    f.remembered.mockRejectedValueOnce(new Error('test-only selection read failure'))
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.certificate_sync_failed' })
    expect(f.accounts.refreshDirectory).not.toHaveBeenCalled()
    expect(f.accounts.certificateRecoveryScope).toHaveBeenCalledOnce()
  })

  it.each(['token', 'logout', 'abort', 'lifecycle', 'selection'] as const)(
    'cancels scope verification when %s changes during the named recovery read',
    async (change) => {
      const f = fixture()
      f.accounts.certificateRecoveryScope.mockImplementationOnce(async () => {
        if (change === 'token') f.accounts.sessionToken.mockReturnValue('9'.repeat(64))
        if (change === 'logout') f.accounts.hasSession.mockReturnValue(false)
        if (change === 'abort') f.controller.abort()
        if (change === 'lifecycle')
          f.assertLifecycle.mockImplementation(() => {
            throw new PeerHelperError('p2p.request_cancelled')
          })
        if (change === 'selection') f.owner.selectionChanged(serviceId)
        return { user: { ...user }, networks: structuredClone(f.directory.networks) }
      })
      await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    }
  )

  it('cancels a token change during manual selection storage read', async () => {
    const f = fixture()
    f.remembered.mockImplementationOnce(async () => {
      f.accounts.sessionToken.mockReturnValue('9'.repeat(64))
      return networkId
    })
    await expect(f.resolve()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.remembered).toHaveBeenCalledOnce()
  })

  it('rereads the exact manual selection before admitting the scoped request', async () => {
    const f = fixture()
    const scope = await f.resolve()
    f.remembered.mockResolvedValueOnce('9'.repeat(12))
    await expect(scope.recheck()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    expect(f.remembered).toHaveBeenLastCalledWith(serviceId, user.userId)
  })

  it('invalidates queued writes after an explicit selection change without forgetting a device', async () => {
    const f = fixture()
    const scope = await f.resolve()
    f.owner.selectionChanged(serviceId)
    expect(() => scope.assertCurrent()).toThrowError('p2p.request_cancelled')
    await expect(scope.recheck()).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
  })
})
