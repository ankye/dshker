import { afterEach, describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi, P2PManagementRequest } from '@/shared/p2p-management'
import {
  projectPeerConnection,
  projectPeerConnections
} from '../../../../electron/main/p2p/management-projection'
import {
  connectionReplyFixture,
  pairId,
  readyState
} from '../../../../electron/main/p2p/tests/connection-reply-fixture'
import { serviceId } from '../../../../electron/main/p2p/tests/management-fixture'
import { P2PManagementDomain } from './p2pManagement'
import { P2PConnectionsDomain } from './p2pConnections'

afterEach(() => vi.useRealTimers())
vi.mock('electron', () => ({ safeStorage: {} }))

describe('connection callback readback race', () => {
  it('reads a late callback after main publishes the actual accepted reply into the immediate snapshot', async () => {
    vi.useFakeTimers()
    const f = connectionReplyFixture()
    const api = {
      connect: vi.fn(async (request: P2PManagementRequest<'connect'>) => ({
        ok: true,
        data: projectPeerConnection(
          request.serviceId,
          await f.owner.connect(request.serviceId, request.pairId, new AbortController().signal)
        )
      })),
      connections: vi.fn(async () => ({
        ok: true,
        data: projectPeerConnections(f.owner.connections())
      }))
    }
    const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
    const connections = new P2PConnectionsDomain(management)
    const connecting = connections.connect(serviceId, pairId)
    const accepted = await f.dispatch
    expect(f.owner.connections().peers).toEqual([])
    f.answer(accepted)
    await connecting
    expect(connections.isReady(serviceId, pairId)).toBe(false)
    expect(connections.find(serviceId, pairId)).toEqual(projectPeerConnection(serviceId, accepted))
    expect(api.connections).toHaveBeenCalledTimes(1)

    // The core's callback updates main after that first read. No new user action
    // occurs; the existing follow-up must read the callback-owned current stage.
    const ready = readyState(accepted)
    await f.peerStage({ serviceId, state: ready })
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(api.connections).toHaveBeenCalledTimes(2)
    expect(connections.find(serviceId, pairId)).toEqual(projectPeerConnection(serviceId, ready))
    expect(connections.isReady(serviceId, pairId)).toBe(true)
  })
})
