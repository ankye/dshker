import { describe, expect, it, vi } from 'vitest'
import { PeerAccounts } from './accounts'
import { PeerCertificateRecoveryScope } from './certificate-recovery-scope'
import type { PeerCredential } from './credentials'
import { PeerDeviceSession } from './device-session'
import {
  legacyCredential,
  recoveredCertificate,
  recoveryNetworkId,
  recoveryToken,
  recoveryUser
} from './tests/legacy-certificate-fixture'
import { PeerHelperError } from './wire'

async function fixture() {
  const serviceId = legacyCredential.serviceId
  let expired = false
  let stored = { revision: '1'.repeat(64), credential: { ...legacyCredential } }
  const projection = {
    user: { ...recoveryUser },
    networks: [
      {
        networkId: recoveryNetworkId,
        userId: recoveryUser.userId,
        name: 'Manually selected original network',
        maxDevices: 10,
        devices: [
          {
            deviceId: legacyCredential.deviceId,
            userId: legacyCredential.userId,
            name: legacyCredential.name,
            presence: 'offline',
            lastSeen: 0,
            version: '',
            platform: '',
            architecture: ''
          }
        ]
      }
    ]
  }
  const call = vi.fn(
    async (method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> => {
      if (method === 'user.login')
        return {
          user: recoveryUser,
          token: recoveryToken,
          expiresAt: Math.floor(Date.now() / 1000) + 3600
        }
      if (method === 'user.current' || method === 'directory.refresh') {
        if (expired) throw new PeerHelperError('p2p.certificate_recovery_required')
        return recoveryUser
      }
      if (method === 'device.certificate_recovery_scope') return structuredClone(projection)
      if (method === 'user.logout') return {}
      if (method === 'device.restore') return { deviceId: legacyCredential.deviceId }
      if (method !== 'device.certificate') throw new PeerHelperError('p2p.invalid_operation')
      const data = (payload as { data: { networkId?: string } }).data
      if (data.networkId === undefined)
        throw new PeerHelperError('p2p.certificate_recovery_required')
      if (data.networkId !== recoveryNetworkId)
        throw new PeerHelperError('p2p.certificate_recovery_forbidden')
      return {
        deviceId: legacyCredential.deviceId,
        publicKey: legacyCredential.publicKey,
        certificate: recoveredCertificate
      }
    }
  )
  const accounts = new PeerAccounts({ call }, async () => undefined)
  const controller = new AbortController()
  await accounts.login(serviceId, recoveryUser.username, 'test-only-password', controller.signal)
  expired = true
  call.mockClear()
  const remembered = vi.fn(
    async (_service: string, _user: string): Promise<string | undefined> => recoveryNetworkId
  )
  const scope = new PeerCertificateRecoveryScope({ remembered })
  const replace = vi.fn(
    async (credential: PeerCredential, revision: string, assertCurrent?: () => void) => {
      assertCurrent?.()
      if (revision !== stored.revision) throw new PeerHelperError('p2p.credential_conflict')
      stored = { revision: '2'.repeat(64), credential: { ...credential } }
      return structuredClone(stored)
    }
  )
  const owner = new PeerDeviceSession({ load: async () => structuredClone(stored), replace }, scope)
  const ready = () =>
    owner.ready(
      serviceId,
      { rpc: { call }, accounts },
      controller.signal,
      async () => recoveryUser.userId
    )
  return { call, accounts, controller, projection, remembered, scope, replace, owner, ready }
}

describe('expired legacy device recovery through the real main owners', () => {
  it('uses one named authorization projection before issuing only the manually selected scope', async () => {
    const f = await fixture()
    await expect(f.ready()).resolves.toBeUndefined()
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.certificate_recovery_scope',
      'device.certificate',
      'device.restore'
    ])
    expect(f.call.mock.calls[1][1]).toEqual({
      serviceId: legacyCredential.serviceId,
      data: { deviceId: legacyCredential.deviceId, token: recoveryToken }
    })
    expect(f.remembered).toHaveBeenCalledWith(legacyCredential.serviceId, recoveryUser.userId)
    expect(f.replace).toHaveBeenCalledOnce()
    expect(f.accounts.hasSession(legacyCredential.serviceId)).toBe(true)
  })

  it('does one named read but never issues a certificate without an explicit manual choice', async () => {
    const f = await fixture()
    f.remembered.mockResolvedValueOnce(undefined)
    await expect(f.ready()).rejects.toMatchObject({ code: 'p2p.certificate_recovery_required' })
    expect(f.call.mock.calls.map(([method]) => method)).toEqual([
      'device.certificate',
      'device.certificate_recovery_scope'
    ])
    expect(f.replace).not.toHaveBeenCalled()
    expect(f.accounts.hasSession(legacyCredential.serviceId)).toBe(true)
  })

  it.each(['abort', 'token', 'user', 'selection', 'forget', 'clear', 'close'] as const)(
    'cannot issue or persist a late recovery projection after %s changes',
    async (change) => {
      const f = await fixture()
      const original = f.call.getMockImplementation()!
      let release!: () => void
      f.call.mockImplementation(async (method, payload, signal) => {
        if (method === 'device.certificate_recovery_scope')
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return original(method, payload, signal)
      })
      const pending = f.ready()
      const rejected = expect(pending).rejects.toMatchObject({
        code:
          change === 'user'
            ? 'p2p.user_scope_mismatch'
            : change === 'close'
              ? 'p2p.helper_unavailable'
              : 'p2p.request_cancelled'
      })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      if (change === 'abort') f.controller.abort()
      if (change === 'token')
        await f.accounts.logout(legacyCredential.serviceId, new AbortController().signal)
      if (change === 'user') f.projection.user.userId = '1'.repeat(12)
      if (change === 'selection') f.scope.selectionChanged(legacyCredential.serviceId)
      if (change === 'forget') f.owner.forget(legacyCredential.serviceId)
      if (change === 'clear') f.owner.clear()
      if (change === 'close') f.accounts.close()
      release()
      await rejected
      expect(f.call.mock.calls.filter(([method]) => method === 'device.certificate')).toHaveLength(
        1
      )
      expect(
        f.call.mock.calls.filter(([method]) => method === 'device.certificate_recovery_scope')
      ).toHaveLength(1)
      expect(f.call.mock.calls.map(([method]) => method)).not.toContain('user.current')
      expect(f.call.mock.calls.map(([method]) => method)).not.toContain('directory.refresh')
      expect(f.call.mock.calls.map(([method]) => method)).not.toContain('device.restore')
      expect(f.replace).not.toHaveBeenCalled()
    }
  )
})
