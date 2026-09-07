import { describe, expect, it } from 'vitest'
import {
  projectPeerCatalog,
  projectPeerUser,
  projectPeerNetwork,
  projectPeerRegistration
} from './management-projection'

describe('management public projections', () => {
  it('returns exact user/network/registration fields even if owners gain private metadata', () => {
    const secrets = {
      token: 'secret',
      privateKey: 'private',
      certificate: 'cert',
      url: 'http://127.0.0.1/?token=private'
    }
    expect(projectPeerUser({ userId: 'user', username: 'alice', ...secrets })).toEqual({
      userId: 'user',
      username: 'alice'
    })
    expect(
      projectPeerNetwork({ networkId: 'net', userId: 'user', name: 'Office', ...secrets })
    ).toEqual({ networkId: 'net', userId: 'user', name: 'Office' })
    const identity = {
      serviceId: 'service',
      userId: 'user',
      name: 'Mac',
      publicKey: 'public',
      revision: 'revision'
    }
    expect(
      projectPeerRegistration({ ...identity, kind: 'registered', deviceId: 'device', ...secrets })
    ).toEqual({ ...identity, kind: 'registered', deviceId: 'device' })
    expect(
      projectPeerRegistration({
        ...identity,
        kind: 'pending',
        requestId: 'request',
        networkId: 'network',
        ...secrets
      })
    ).toEqual({ ...identity, kind: 'pending', requestId: 'request', networkId: 'network' })
  })
  it('projects all computer identities without sharing mutable catalog arrays or private fields', () => {
    const computer = {
      connectionId: 'connection',
      serviceId: 'service',
      displayName: 'Mac',
      pairId: 'pair',
      networkId: 'net',
      localDeviceId: 'local',
      remoteDeviceId: 'remote',
      userId: 'user',
      localPublicKey: 'local-key',
      remotePublicKey: 'remote-key',
      pairRevision: 2,
      pairState: 'revoked' as const
    }
    const snapshot = {
      revision: 'revision',
      record: {
        format: 'dshker.p2p-devices' as const,
        version: 1 as const,
        catalogId: 'catalog',
        services: [],
        computers: [{ ...computer, token: 'secret' }],
        forgottenServiceIds: ['forgotten']
      }
    }
    const projected = projectPeerCatalog(snapshot)
    expect(projected).toEqual({
      revision: 'revision',
      catalogId: 'catalog',
      services: [],
      computers: [computer],
      forgottenServiceIds: ['forgotten']
    })
    projected.computers[0].displayName = 'edited page copy'
    projected.forgottenServiceIds.length = 0
    expect(snapshot.record.computers[0].displayName).toBe('Mac')
    expect(snapshot.record.forgottenServiceIds).toEqual(['forgotten'])
  })
})
