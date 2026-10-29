import { vi } from 'vitest'
import { PeerCredentialStore } from '../credentials'
import type { PeerHelperState } from '../helper-state'
import { fixture, serviceId, user } from './management-fixture'

export const pairId = '2'.repeat(12)

/** Real main composition with only the external core reply held by the test. */
export function connectionReplyFixture() {
  const f = fixture()
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
  let dispatched!: (state: PeerHelperState) => void
  const dispatch = new Promise<PeerHelperState>((resolve) => (dispatched = resolve))
  let answer!: (reply: { state: PeerHelperState; url: string }) => void
  const reply = new Promise<{ state: PeerHelperState; url: string }>(
    (resolve) => (answer = resolve)
  )
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, payload, signal) => {
    if (method !== 'peer.connect') return original(method, payload, signal)
    const { data } = payload as { data: { pairId: string; generation: number } }
    dispatched({
      pairId: data.pairId,
      attemptId: '7'.repeat(12),
      generation: data.generation,
      stage: 'punching',
      error: '',
      path: { localType: '', remoteType: '', protocol: '' },
      runtimeGeneration: 0
    })
    return reply
  })
  return { ...f, dispatch, answer: (state: PeerHelperState) => answer({ state, url: '' }) }
}

export function readyState(state: PeerHelperState): PeerHelperState {
  return {
    ...state,
    stage: 'ready',
    runtimeGeneration: 1,
    path: { localType: 'host', remoteType: 'srflx', protocol: 'udp' }
  }
}
