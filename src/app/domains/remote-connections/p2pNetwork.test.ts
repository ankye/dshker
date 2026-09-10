import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PNetworkDomain } from './p2pNetwork'

const serviceId = 'service-a'

function setup(overrides: Partial<P2PManagementApi> = {}) {
  const api = {
    serviceSessions: vi.fn(async () => ({
      ok: true as const,
      data: [{ serviceId, state: 'online' as const, code: '' }]
    })),
    ...overrides
  } as unknown as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  return { api, management, network: new P2PNetworkDomain(management) }
}

describe('P2P network layer', () => {
  it('separates an unread session from a confirmed offline one', () => {
    // The status bar reports reach from every route, so it must be able to say
    // "not looked yet" instead of asserting the computer is unreachable.
    const { network } = setup()
    expect(network.isOnline(serviceId)).toBeUndefined()
    expect(network.state.sessions).toBeUndefined()
  })

  it('reports the coordinator session, independent of any pair connection', async () => {
    const { network } = setup()
    await network.read()
    expect(network.isOnline(serviceId)).toBe(true)
    expect(network.refusal(serviceId)).toBe('')
  })

  it('keeps the refusal that explains a down session', async () => {
    const { network } = setup({
      serviceSessions: vi.fn(async () => ({
        ok: true as const,
        data: [{ serviceId, state: 'offline' as const, code: 'p2p.device_unregistered' }]
      }))
    } as unknown as Partial<P2PManagementApi>)
    await network.read()
    expect(network.isOnline(serviceId)).toBe(false)
    // Without this the product could only say "offline" and the cause was
    // reachable only by inspecting files on disk.
    expect(network.refusal(serviceId)).toBe('p2p.device_unregistered')
  })

  it('reports offline for a service absent from the session list', async () => {
    const { network } = setup()
    await network.read()
    expect(network.isOnline('service-b')).toBe(false)
  })

  it('leaves the last read intact when a refused read returns nothing', async () => {
    const api = {
      serviceSessions: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          data: [{ serviceId, state: 'online', code: '' }]
        })
        .mockResolvedValueOnce({ ok: false, code: 'p2p.service_busy', message: 'busy' })
    } as unknown as P2PManagementApi
    const management = new P2PManagementDomain(() => api)
    const network = new P2PNetworkDomain(management)
    await network.read()
    await network.read()
    // A refused read is not evidence of being offline.
    expect(network.isOnline(serviceId)).toBe(true)
  })
})
