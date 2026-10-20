import { describe, expect, it, vi } from 'vitest'
import type { PeerCatalogRecord, PeerComputerRecord, PeerServiceRecord } from './catalog-schema'
import type { PeerHelperState } from './helper-state'
import { peerPartition } from './partitions'
import { readPeerWorkbenchEntry } from './workbench-entry'
import { PeerHelperError } from './wire'

const serviceId = 'a'.repeat(12)
const pairId = 'b'.repeat(12)
const request = { serviceId, pairId, generation: 7 }
const url = 'http://127.0.0.1:41234/?token=test-only-entry'

function state(overrides: Partial<PeerHelperState> = {}): PeerHelperState {
  return {
    pairId,
    attemptId: 'c'.repeat(12),
    generation: 7,
    stage: 'ready',
    error: '',
    path: { localType: 'host', remoteType: 'srflx', protocol: 'udp' },
    runtimeGeneration: 3,
    ...overrides
  }
}

function fixture() {
  const service: PeerServiceRecord = {
    serviceId,
    displayName: 'Coordinator',
    httpsOrigin: 'https://coordinator.test',
    wssUrl: 'wss://coordinator.test/signals',
    stunAddress: 'coordinator.test:3478',
    publicKey: 'test-only-public-key',
    certificate: 'test-only-certificate'
  }
  const computer: PeerComputerRecord = {
    serviceId,
    pairId,
    connectionId: 'd'.repeat(12),
    displayName: 'Remote',
    networkId: 'e'.repeat(12),
    localDeviceId: 'f'.repeat(12),
    remoteDeviceId: '1'.repeat(12),
    userId: '2'.repeat(12),
    localPublicKey: 'local-test-key',
    remotePublicKey: 'remote-test-key',
    pairRevision: 1,
    pairState: 'active'
  }
  const record: PeerCatalogRecord = {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: '9'.repeat(12),
    services: [service],
    computers: [computer],
    forgottenServiceIds: []
  }
  const inspect = vi.fn(async () => ({ revision: '3'.repeat(64), record }))
  let current: PeerHelperState | undefined = state()
  let live = true
  const call = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    serviceId,
    state: state(),
    url
  }))
  const owner = {
    rpc: { call },
    catalog: { inspect },
    current: vi.fn(() => current),
    admit: () => {
      if (!live) throw new PeerHelperError('p2p.helper_unavailable')
    }
  }
  const controller = new AbortController()
  return {
    owner,
    call,
    inspect,
    record,
    computer,
    controller,
    setCurrent: (value: PeerHelperState | undefined) => (current = value),
    close: () => (live = false),
    read: () => readPeerWorkbenchEntry(owner, request, controller.signal)
  }
}

describe('authoritative peer workbench entry readback', () => {
  it('reads the recovered ready generation from the core without connecting or starting DSH', async () => {
    const f = fixture()
    await expect(f.read()).resolves.toEqual({ url, partition: peerPartition(serviceId, pairId) })
    expect(f.call).toHaveBeenCalledExactlyOnceWith(
      'peer.entry',
      { serviceId, data: { pairId, generation: 7 } },
      f.controller.signal
    )
    expect(f.inspect).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing service', (f: ReturnType<typeof fixture>) => (f.record.services = [])],
    [
      'forgotten service',
      (f: ReturnType<typeof fixture>) => f.record.forgottenServiceIds.push(serviceId)
    ],
    ['missing pair', (f: ReturnType<typeof fixture>) => (f.record.computers = [])],
    ['revoked pair', (f: ReturnType<typeof fixture>) => (f.computer.pairState = 'revoked')]
  ])('refuses %s before asking the core', async (_name, invalidate) => {
    const f = fixture()
    invalidate(f)
    await expect(f.read()).rejects.toBeInstanceOf(PeerHelperError)
    expect(f.call).not.toHaveBeenCalled()
  })

  it.each([
    ['absent', undefined, 'p2p.connection_not_found'],
    ['transport only', state({ stage: 'connected', runtimeGeneration: 0 }), 'p2p.not_connected'],
    ['stale', state({ generation: 8 }), 'p2p.stale_generation']
  ])('refuses a %s local stage before asking the core', async (_name, current, code) => {
    const f = fixture()
    f.setCurrent(current)
    await expect(f.read()).rejects.toMatchObject({ code })
    expect(f.call).not.toHaveBeenCalled()
  })

  it.each([
    [
      'different service',
      { serviceId: '4'.repeat(12), state: state(), url },
      'p2p.identity_mismatch'
    ],
    [
      'different pair',
      { serviceId, state: state({ pairId: '4'.repeat(12) }), url },
      'p2p.identity_mismatch'
    ],
    [
      'different generation',
      { serviceId, state: state({ generation: 8 }), url },
      'p2p.stale_generation'
    ],
    [
      'different attempt',
      { serviceId, state: state({ attemptId: '4'.repeat(12) }), url },
      'p2p.stale_generation'
    ],
    [
      'different runtime',
      { serviceId, state: state({ runtimeGeneration: 4 }), url },
      'p2p.stale_generation'
    ],
    [
      'transport only',
      { serviceId, state: state({ stage: 'connected', runtimeGeneration: 0 }), url },
      'p2p.not_connected'
    ],
    ['extra field', { serviceId, state: state(), url, cached: true }, 'p2p.protocol_mismatch']
  ])('rejects a core reply for %s', async (_name, reply, code) => {
    const f = fixture()
    f.call.mockResolvedValueOnce(reply)
    await expect(f.read()).rejects.toMatchObject({ code })
  })

  it.each([
    '',
    'file:///tmp/workbench',
    'https://remote.test/',
    'http://127.0.0.1.evil.test/',
    'http://user:password@127.0.0.1:1234/'
  ])('rejects an invalid gateway URL %s', async (entryUrl) => {
    const f = fixture()
    f.call.mockResolvedValueOnce({ serviceId, state: state(), url: entryUrl })
    await expect(f.read()).rejects.toMatchObject({ code: 'p2p.invalid_socket' })
  })

  it.each([
    [
      'revocation',
      (f: ReturnType<typeof fixture>) => (f.computer.pairState = 'revoked'),
      'p2p.pair_unauthorized'
    ],
    [
      'pair replacement',
      (f: ReturnType<typeof fixture>) => f.computer.pairRevision++,
      'p2p.stale_generation'
    ],
    [
      'supersession',
      (f: ReturnType<typeof fixture>) => f.setCurrent(state({ generation: 8 })),
      'p2p.stale_generation'
    ],
    [
      'new attempt at the same generation',
      (f: ReturnType<typeof fixture>) => f.setCurrent(state({ attemptId: '4'.repeat(12) })),
      'p2p.stale_generation'
    ],
    [
      'disconnect',
      (f: ReturnType<typeof fixture>) => f.setCurrent(state({ stage: 'disconnected' })),
      'p2p.not_connected'
    ],
    ['close', (f: ReturnType<typeof fixture>) => f.close(), 'p2p.helper_unavailable'],
    [
      'cancellation',
      (f: ReturnType<typeof fixture>) => f.controller.abort(),
      'p2p.request_cancelled'
    ]
  ])('rejects a ready reply after %s during its lookup', async (_name, change, code) => {
    const f = fixture()
    f.call.mockImplementationOnce(async () => {
      change(f)
      return { serviceId, state: state(), url }
    })
    await expect(f.read()).rejects.toMatchObject({ code })
  })

  it('preserves the core typed refusal rather than returning an old address', async () => {
    const f = fixture()
    f.call.mockRejectedValueOnce(new PeerHelperError('p2p.runtime_unavailable'))
    await expect(f.read()).rejects.toMatchObject({ code: 'p2p.runtime_unavailable' })
  })
})
