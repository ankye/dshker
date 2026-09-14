import { describe, expect, it, vi } from 'vitest'
import type { PeerCatalog } from './catalog'
import type { PeerPairMember } from './pair-records'
import { recordMembers } from './member-catalog'

const serviceId = 'a'.repeat(64)
const otherService = 'b'.repeat(64)
const credential = {
  deviceId: '3'.repeat(32),
  userId: '4'.repeat(32),
  publicKey: Buffer.alloc(32, 7).toString('base64')
}
const remotePublicKey = Buffer.alloc(32, 9).toString('base64')

function member(overrides: Partial<PeerPairMember> = {}): PeerPairMember {
  return {
    networkId: 'c'.repeat(32),
    state: 'active',
    revision: 3,
    initiator: {
      deviceId: credential.deviceId,
      userId: credential.userId,
      publicKey: credential.publicKey,
      name: 'this'
    },
    target: {
      deviceId: '5'.repeat(32),
      userId: credential.userId,
      publicKey: remotePublicKey,
      name: 'peer'
    },
    ...overrides
  } as PeerPairMember
}

function computer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: '5'.repeat(32),
    serviceId,
    displayName: 'peer',
    pairId: '5'.repeat(32),
    networkId: 'c'.repeat(32),
    localDeviceId: credential.deviceId,
    remoteDeviceId: '5'.repeat(32),
    userId: credential.userId,
    localPublicKey: credential.publicKey,
    remotePublicKey,
    pairRevision: 3,
    pairState: 'active',
    ...overrides
  }
}

function fixture(computers: readonly Record<string, unknown>[]) {
  let committed: { computers: readonly Record<string, unknown>[] } | undefined
  const commits: Array<{ computers: readonly Record<string, unknown>[] }> = []
  const record = {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: 'd'.repeat(32),
    services: [
      {
        serviceId,
        displayName: 's',
        httpsOrigin: 'https://example.test',
        wssUrl: 'wss://example.test',
        stunAddress: 'example.test:3478',
        publicKey: credential.publicKey,
        certificate: 'x'
      }
    ],
    computers: structuredClone(computers),
    forgottenServiceIds: []
  }
  const catalog = {
    inspect: vi.fn(async () => ({ revision: 'e'.repeat(64), record: structuredClone(record) })),
    commit: vi.fn(async (_revision: string, next: typeof record) => {
      committed = next as unknown as { computers: readonly Record<string, unknown>[] }
      commits.push(committed)
      return { revision: 'f'.repeat(64), record: next }
    })
  } as unknown as PeerCatalog
  return { catalog, committed: () => committed, commits: () => commits }
}

describe('member catalog rewrite', () => {
  it('records an active pair as one computer for this service', async () => {
    const f = fixture([])
    await recordMembers(f.catalog, serviceId, credential, [member()])
    expect(f.committed()?.computers.map((value) => String(value.remoteDeviceId))).toEqual([
      '5'.repeat(32)
    ])
  })

  it('drops a record that named this machine as its own peer, wherever it lives', async () => {
    // An older build wrote that; it belongs to the service being rewritten, so
    // without this the row survives every prune as an impossible second device.
    const selfPair = computer({ serviceId: otherService, remoteDeviceId: credential.deviceId })
    const f = fixture([selfPair])
    await recordMembers(f.catalog, serviceId, credential, [])
    expect(f.committed()?.computers).toEqual([])
  })

  it('marks this service rows the coordinator no longer reports as revoked, and keeps other services', async () => {
    const stale = computer({
      remoteDeviceId: '6'.repeat(32),
      connectionId: '6'.repeat(32),
      pairId: '6'.repeat(32)
    })
    const other = computer({
      serviceId: otherService,
      remoteDeviceId: '7'.repeat(32),
      connectionId: '7'.repeat(32),
      pairId: '7'.repeat(32)
    })
    const f = fixture([stale, other])
    await recordMembers(f.catalog, serviceId, credential, [member()])
    const committed = f.committed()?.computers ?? []
    expect(committed.map((value) => String(value.remoteDeviceId)).sort()).toEqual([
      '5'.repeat(32),
      '6'.repeat(32),
      '7'.repeat(32)
    ])
    // The omitted row is recorded as revoked, not dropped: dropping an active
    // pair is the transition the catalog's guard refuses, which wedged every
    // sync once both devices had re-enrolled under new identities.
    expect(
      committed.find((value) => String(value.remoteDeviceId) === '6'.repeat(32))?.pairState
    ).toBe('revoked')
    expect(
      committed.find((value) => String(value.remoteDeviceId) === '5'.repeat(32))?.pairState
    ).toBe('active')
  })

  it('does not carry a revoked row into the next rewrite', async () => {
    const alreadyRevoked = computer({
      remoteDeviceId: '6'.repeat(32),
      connectionId: '6'.repeat(32),
      pairId: '6'.repeat(32),
      pairState: 'revoked'
    })
    const f = fixture([alreadyRevoked])
    await recordMembers(f.catalog, serviceId, credential, [member()])
    expect(f.committed()?.computers.map((value) => String(value.remoteDeviceId))).toEqual([
      '5'.repeat(32)
    ])
  })

  it('retires a revoked connection in its own commit before recording it again', async () => {
    // The catalog refuses to take a revoked computer back to active, so a peer
    // the coordinator has authorized again (re-paired, or a network rejoined)
    // could never be recorded — the member sync failed on every sweep and the
    // computer stayed revoked on screen. Retirement is the legal step, and it
    // has to be committed before the new authorization.
    const revokedRow = computer({
      remoteDeviceId: '6'.repeat(32),
      connectionId: '6'.repeat(32),
      pairId: '6'.repeat(32),
      pairState: 'revoked'
    })
    const f = fixture([revokedRow])
    const repaired = member({ target: { ...member().target, deviceId: '6'.repeat(32) } })
    await recordMembers(f.catalog, serviceId, credential, [repaired])
    const commits = f.commits()
    expect(commits.map((entry) => entry.computers.length)).toEqual([0, 1])
    expect(
      commits[1]?.computers.map((value) => [String(value.remoteDeviceId), String(value.pairState)])
    ).toEqual([['6'.repeat(32), 'active']])
  })

  it('admits only an active pair with a positive revision', async () => {
    const f = fixture([])
    await recordMembers(f.catalog, serviceId, credential, [
      member({ state: 'revoked' as PeerPairMember['state'] }),
      member({ revision: 0 })
    ])
    expect(f.committed()?.computers).toEqual([])
  })
})
