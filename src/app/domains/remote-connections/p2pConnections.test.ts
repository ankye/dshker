import { describe, expect, it, vi } from 'vitest'
import type { P2PConnectionView, P2PManagementApi } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PConnectionsDomain } from './p2pConnections'

const serviceId = 'service-a'
const pairId = 'pair-a'
const other = 'pair-b'

function peer(
  stage: P2PConnectionView['stage'],
  overrides: Partial<P2PConnectionView> = {}
): P2PConnectionView {
  return {
    serviceId,
    pairId,
    attemptId: 'attempt-a',
    generation: 3,
    stage,
    error: stage === 'failed' ? 'p2p.operation_failed' : '',
    path:
      stage === 'ready'
        ? { localType: 'host', remoteType: 'srflx', protocol: 'udp' }
        : { localType: '', remoteType: '', protocol: '' },
    runtimeGeneration: stage === 'ready' ? 2 : 0,
    ...overrides
  }
}

function setup(peers: P2PConnectionView[] = []) {
  const api = {
    connections: vi
      .fn<P2PManagementApi['connections']>()
      .mockResolvedValue({ ok: true, data: { error: '', peers } }),
    connect: vi
      .fn<P2PManagementApi['connect']>()
      .mockResolvedValue({ ok: true, data: peer('punching') }),
    disconnect: vi
      .fn<P2PManagementApi['disconnect']>()
      .mockResolvedValue({ ok: true, data: undefined })
  }
  const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
  return { api, connections: new P2PConnectionsDomain(management) }
}

describe('renderer P2P connections domain', () => {
  it('never exposes a DSH URL, cookie or token', async () => {
    const { connections } = setup([peer('ready')])
    await connections.read()
    const serialized = JSON.stringify(connections.state)
    expect(serialized).not.toMatch(/127\.0\.0\.1|http:|cookie|token/i)
  })

  it('reports ready only for a fully established workbench', async () => {
    const { connections } = setup([peer('ready')])
    await connections.read()
    expect(connections.isReady(serviceId, pairId)).toBe(true)
    expect(connections.isConnecting(serviceId, pairId)).toBe(false)
  })

  it('does not treat an in-flight attempt as connected', async () => {
    for (const stage of ['punching', 'starting-runtime'] as const) {
      const { connections } = setup([peer(stage)])
      await connections.read()
      expect(connections.isReady(serviceId, pairId)).toBe(false)
      expect(connections.isConnecting(serviceId, pairId)).toBe(true)
    }
  })

  it('does not treat a failed or disconnected peer as connected', async () => {
    for (const stage of ['failed', 'disconnected'] as const) {
      const { connections } = setup([peer(stage)])
      await connections.read()
      expect(connections.isReady(serviceId, pairId)).toBe(false)
      expect(connections.isConnecting(serviceId, pairId)).toBe(false)
    }
  })

  it('keeps each pair independent so one failure does not mark another ready', async () => {
    const { connections } = setup([peer('failed'), peer('ready', { pairId: other })])
    await connections.read()
    expect(connections.isReady(serviceId, pairId)).toBe(false)
    expect(connections.isReady(serviceId, other)).toBe(true)
  })

  it('reports a direct path only when the transport really is direct', async () => {
    const { connections } = setup([peer('ready')])
    await connections.read()
    expect(connections.isDirect(serviceId, pairId)).toBe(true)
    const relayed = setup([
      peer('ready', { path: { localType: '', remoteType: '', protocol: '' } })
    ])
    await relayed.connections.read()
    expect(relayed.connections.isDirect(serviceId, pairId)).toBe(false)
  })

  it('does not report a stage for a pair that never connected', async () => {
    const { connections } = setup([])
    await connections.read()
    expect(connections.find(serviceId, pairId)).toBeUndefined()
    expect(connections.isReady(serviceId, pairId)).toBe(false)
  })

  it('reads back after dispatch instead of assuming the attempt succeeded', async () => {
    const { api, connections } = setup([peer('punching')])
    await connections.connect(serviceId, pairId)
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(api.connections).toHaveBeenCalled()
    expect(connections.isReady(serviceId, pairId)).toBe(false)
  })

  it('does not start a second attempt while one is already negotiating', async () => {
    const { api, connections } = setup([peer('punching')])
    await connections.read()
    await connections.connect(serviceId, pairId)
    expect(api.connect).not.toHaveBeenCalled()
  })

  it('blocks further writes after an outcome that may have taken effect', async () => {
    const { api, connections } = setup([])
    api.connect.mockResolvedValue({ ok: false, code: 'p2p.server_unavailable', message: 'unknown' })
    await connections.connect(serviceId, pairId)
    expect(connections.state.resultUnconfirmed).toBe(true)
    await connections.connect(serviceId, pairId)
    expect(api.connect).toHaveBeenCalledTimes(1)
  })

  it('lets a readback clear an unknown outcome', async () => {
    const { api, connections } = setup([])
    api.connect.mockResolvedValue({ ok: false, code: 'p2p.server_unavailable', message: 'unknown' })
    await connections.connect(serviceId, pairId)
    await connections.read()
    expect(connections.state.resultUnconfirmed).toBe(false)
  })

  it('treats a definite refusal as known so the user is not blocked', async () => {
    const { api, connections } = setup([])
    api.connect.mockResolvedValue({ ok: false, code: 'p2p.connection_busy', message: 'busy' })
    await connections.connect(serviceId, pairId)
    expect(connections.state.resultUnconfirmed).toBe(false)
  })

  it('surfaces a helper-level error separately from a connection failure', async () => {
    const { api, connections } = setup([])
    api.connections.mockResolvedValue({
      ok: true,
      data: { error: 'p2p.helper_unavailable', peers: [] }
    })
    await connections.read()
    expect(connections.state.helperError).toBe('p2p.helper_unavailable')
  })
})
