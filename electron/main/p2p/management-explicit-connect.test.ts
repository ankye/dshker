import { describe, expect, it, vi } from 'vitest'
import { PeerCredentialStore } from './credentials'
import { PeerHelperError } from './wire'
import { fixture, serviceId, user } from './tests/management-fixture'

vi.mock('electron', () => ({ safeStorage: {} }))

const pairId = '2'.repeat(12)

function enrolled() {
  const saved = {
    revision: 'a'.repeat(64),
    credential: {
      serviceId,
      deviceId: '3'.repeat(12),
      userId: user.userId,
      name: 'This machine',
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      certificate: Buffer.from('test-only-credential-boundary').toString('base64'),
      privateKey: Buffer.alloc(32, 9).toString('base64')
    }
  }
  vi.spyOn(PeerCredentialStore.prototype, 'load').mockResolvedValue(saved)
  vi.spyOn(PeerCredentialStore.prototype, 'loadRegistration').mockResolvedValue({
    kind: 'registered',
    ...saved
  })
}

function accepted(generation: number, target = pairId) {
  return {
    state: {
      pairId: target,
      attemptId: '7'.repeat(12),
      generation,
      stage: 'punching',
      error: '',
      path: { localType: '', remoteType: '', protocol: '' },
      runtimeGeneration: 0
    },
    url: ''
  }
}

describe('explicit connection ownership', () => {
  it('does not start an automatic candidate ahead of the one explicit request', async () => {
    const f = fixture()
    enrolled()
    const original = f.call.getMockImplementation()!
    let automaticCandidate = false
    f.call.mockImplementation(async (method, payload, signal) => {
      if (method !== 'peer.connect') return original(method, payload, signal)
      const request = payload as {
        serviceId: string
        data: { pairId: string; generation: number; requestWorkbench?: boolean }
      }
      if (!request.data.requestWorkbench) automaticCandidate = true
      if (request.data.requestWorkbench && automaticCandidate)
        throw new PeerHelperError('p2p.connection_busy')
      return accepted(request.data.generation, request.data.pairId)
    })

    const state = await f.owner.connect(serviceId, pairId, new AbortController().signal)
    const attempts = f.call.mock.calls.filter(([method]) => method === 'peer.connect')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.[1]).toMatchObject({
      serviceId,
      data: { pairId, generation: state.generation, requestWorkbench: true }
    })
    expect(state.stage).toBe('punching')
    expect(state.generation).toBeGreaterThan(1_000_000_000)
    expect(automaticCandidate).toBe(false)
    expect(f.call.mock.calls.some(([method]) => method.startsWith('peer.autoconnect_'))).toBe(false)
  })

  it('retains the core admission refusal without redispatching or waking another candidate', async () => {
    const f = fixture()
    enrolled()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (method, payload, signal) => {
      if (method === 'peer.connect') throw new PeerHelperError('p2p.connection_busy')
      return original(method, payload, signal)
    })

    await expect(
      f.owner.connect(serviceId, pairId, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'p2p.connection_busy' })
    const attempts = f.call.mock.calls.filter(([method]) => method === 'peer.connect')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.[1]).toMatchObject({
      serviceId,
      data: { pairId, requestWorkbench: true }
    })
    expect(f.call.mock.calls.some(([method]) => method.startsWith('peer.autoconnect_'))).toBe(false)
  })
})
