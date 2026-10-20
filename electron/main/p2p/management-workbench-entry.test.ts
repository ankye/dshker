import { describe, expect, it, vi } from 'vitest'
import { PeerDeviceSession } from './device-session'
import type { PeerHelperState } from './helper-state'
import { fixture, serviceId, user } from './tests/management-fixture'

vi.mock('electron', () => ({ safeStorage: {} }))

const pairId = '2'.repeat(12)
const ready: PeerHelperState = {
  pairId,
  attemptId: '8'.repeat(12),
  generation: 91,
  stage: 'ready',
  error: '',
  path: { localType: 'host', remoteType: 'host', protocol: 'udp' },
  runtimeGeneration: 2
}

async function pendingEntry() {
  const f = fixture()
  const controller = new AbortController()
  await f.owner.login(serviceId, user.username, 'test-password', controller.signal)
  await f.peerStage({ serviceId, state: ready })
  let answer!: () => void
  let announce!: () => void
  const started = new Promise<void>((resolve) => (announce = resolve))
  const base = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, payload, signal) => {
    if (method === 'peer.entry') {
      announce()
      return new Promise((resolve) => {
        answer = () => resolve({ serviceId, state: ready, url: 'http://127.0.0.1:41391/' })
      })
    }
    if (method === 'peer.disconnect') return {}
    return base(method, payload, signal)
  })
  const lookup = f.owner.entry(serviceId, pairId, ready.generation, controller.signal)
  await started
  return { ...f, lookup, answer, controller }
}

describe('main ownership during an asynchronous workbench entry read', () => {
  it('rejects the old answer when disconnect settles before its stage callback', async () => {
    const f = await pendingEntry()
    vi.spyOn(PeerDeviceSession.prototype, 'ready').mockResolvedValue(undefined)
    await f.owner.disconnect(serviceId, pairId, new AbortController().signal)
    // No peer.state was sent: the snapshot still says ready at the old generation.
    expect(f.owner.connections().peers[0]?.state).toEqual(ready)
    f.answer()
    await expect(f.lookup).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    expect(f.runtimeStart).not.toHaveBeenCalled()
  })

  it('rejects the old answer when main closes while the core is answering', async () => {
    const f = await pendingEntry()
    await f.owner.close()
    f.answer()
    await expect(f.lookup).rejects.toMatchObject({ code: 'p2p.helper_closed' })
  })

  it('rejects the old answer when the attached core channel is lost', async () => {
    const f = await pendingEntry()
    f.unavailable()
    f.answer()
    await expect(f.lookup).rejects.toMatchObject({ code: 'p2p.helper_unavailable' })
  })

  it('rejects an old answer after its service is removed', async () => {
    const f = await pendingEntry()
    await f.owner.removeService(serviceId, new AbortController().signal)
    f.answer()
    await expect(f.lookup).rejects.toMatchObject({ code: 'p2p.stale_generation' })
  })
})
