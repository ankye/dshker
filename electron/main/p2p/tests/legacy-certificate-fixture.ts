import { vi } from 'vitest'
import type { PeerDirectory } from '../account-records'
import { PeerCertificateRecoveryScope } from '../certificate-recovery-scope'
import type { PeerCredential } from '../credentials'
import { PeerDeviceSession } from '../device-session'
import { PeerHelperError } from '../wire'

export const legacyCredential: PeerCredential = {
  serviceId: 'a'.repeat(12),
  deviceId: 'b'.repeat(12),
  userId: 'c'.repeat(12),
  name: 'Original legacy device',
  publicKey: Buffer.alloc(32, 1).toString('base64'),
  privateKey: Buffer.alloc(64, 2).toString('base64'),
  certificate: Buffer.from('expired original certificate').toString('base64')
}
export const recoveryNetworkId = 'd'.repeat(12)
export const recoveryUser = { userId: 'e'.repeat(12), username: 'network-owner' }
export const recoveryToken = 'f'.repeat(64)
export const recoveredCertificate = Buffer.from('verified recovered certificate').toString('base64')

export function legacyCertificateFixture(original: PeerCredential = legacyCredential) {
  let stored = { revision: '1'.repeat(64), credential: { ...original } }
  let canonicalCertificate: string | undefined
  const load = vi.fn(async () => structuredClone(stored))
  const replace = vi.fn(
    async (credential: PeerCredential, revision: string, assertCurrent?: () => void) => {
      assertCurrent?.()
      if (revision !== stored.revision) throw new PeerHelperError('p2p.credential_conflict')
      stored = { revision: '2'.repeat(64), credential: { ...credential } }
      return structuredClone(stored)
    }
  )
  const remembered = vi.fn(
    async (_service: string, _user: string): Promise<string | undefined> => recoveryNetworkId
  )
  const directory: PeerDirectory = {
    known: true,
    revision: 1,
    fetchedAt: 1,
    devices: [],
    networks: [
      {
        networkId: recoveryNetworkId,
        userId: recoveryUser.userId,
        name: 'Selected network',
        maxDevices: 10,
        devices: [
          {
            deviceId: original.deviceId,
            userId: original.userId,
            name: original.name,
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
  const accounts = {
    hasSession: vi.fn(() => true),
    sessionToken: vi.fn((): string | undefined => recoveryToken),
    currentUser: vi.fn(async () => ({ ...recoveryUser })),
    refreshDirectory: vi.fn(async () => structuredClone(directory)),
    certificateRecoveryScope: vi.fn(async () => ({
      user: { ...recoveryUser },
      networks: structuredClone(directory.networks)
    }))
  }
  const call = vi.fn(
    async (method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> => {
      if (method === 'device.restore') return { deviceId: original.deviceId }
      if (method !== 'device.certificate') throw new PeerHelperError('p2p.invalid_operation')
      const data = (payload as { data: { networkId?: string } }).data
      if (canonicalCertificate === undefined) {
        if (data.networkId !== recoveryNetworkId)
          throw new PeerHelperError('p2p.certificate_recovery_required')
        canonicalCertificate = recoveredCertificate
      }
      return {
        deviceId: original.deviceId,
        publicKey: original.publicKey,
        certificate: canonicalCertificate
      }
    }
  )
  const scope = new PeerCertificateRecoveryScope({ remembered })
  const createOwner = () => new PeerDeviceSession({ load, replace }, scope)
  const owner = createOwner()
  const reportedAccount = vi.fn(async () => recoveryUser.userId)
  const session = { rpc: { call }, accounts }
  const ready = (
    signal = new AbortController().signal,
    maintain: boolean | 'after-login' = false
  ) => owner.ready(original.serviceId, session, signal, reportedAccount, maintain)
  return {
    owner,
    createOwner,
    ready,
    load,
    replace,
    remembered,
    scope,
    accounts,
    directory,
    call,
    session,
    reportedAccount,
    stored: () => structuredClone(stored),
    canonical: () => canonicalCertificate,
    setCanonical: (certificate: string) => {
      canonicalCertificate = certificate
    }
  }
}
