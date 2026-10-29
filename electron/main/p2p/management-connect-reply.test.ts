import { describe, expect, it, vi } from 'vitest'
import { connectionReplyFixture, pairId, readyState } from './tests/connection-reply-fixture'
import { serviceId } from './tests/management-fixture'

vi.mock('electron', () => ({ safeStorage: {} }))

const signal = () => new AbortController().signal

describe('connect reply state admission', () => {
  it('publishes the actual accepted owner before returning without a state callback', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const accepted = await f.dispatch
    expect(f.owner.connections().peers).toEqual([])
    f.answer(accepted)
    await expect(pending).resolves.toEqual(accepted)
    expect(f.owner.connections().peers).toEqual([{ serviceId, state: accepted }])
  })

  it('keeps a newer ready callback when the accepted reply arrives afterward', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const accepted = await f.dispatch
    const ready = readyState(accepted)
    await f.peerStage({ serviceId, state: ready })
    f.answer(accepted)
    await pending
    expect(f.owner.connections().peers).toEqual([{ serviceId, state: ready }])
  })

  it('accepts the new actual owner after the preexisting bind-only owner reports failure', async () => {
    const f = connectionReplyFixture()
    await f.owner.registration(serviceId, signal())
    const old = {
      pairId,
      attemptId: '6'.repeat(12),
      generation: 1,
      stage: 'punching' as const,
      error: '',
      path: { localType: '' as const, remoteType: '' as const, protocol: '' as const },
      runtimeGeneration: 0
    }
    await f.peerStage({ serviceId, state: old })
    const pending = f.owner.connect(serviceId, pairId, signal())
    const accepted = await f.dispatch
    await f.peerStage({
      serviceId,
      state: { ...old, stage: 'failed', error: 'p2p.runtime_unavailable' }
    })
    f.answer(accepted)
    await pending
    expect(f.owner.connections().peers).toEqual([{ serviceId, state: accepted }])
  })

  it('never revives a disconnected attempt from its delayed punching reply', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const accepted = await f.dispatch
    const disconnected = { ...accepted, stage: 'disconnected' as const }
    await f.peerStage({ serviceId, state: disconnected })
    f.answer(accepted)
    await pending
    expect(f.owner.connections().peers).toEqual([{ serviceId, state: disconnected }])
  })

  it('refuses a delayed reply after a different actual attempt supersedes it', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    const accepted = await f.dispatch
    const current = { ...readyState(accepted), attemptId: '8'.repeat(12), generation: 1 }
    await f.peerStage({ serviceId, state: current })
    f.answer(accepted)
    await refused
    expect(f.owner.connections().peers).toEqual([{ serviceId, state: current }])
  })

  it('rechecks current pair authorization before publishing a late reply', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.pair_unauthorized' })
    const accepted = await f.dispatch
    f.record().computers[0]!.pairState = 'revoked'
    f.answer(accepted)
    await refused
    expect(f.owner.connections().peers).toEqual([])
  })

  it('fences a late reply when the service was removed while dispatch was pending', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    const accepted = await f.dispatch
    await f.owner.removeService(serviceId, signal())
    f.answer(accepted)
    await refused
    expect(f.owner.connections().peers).toEqual([])
  })

  it('refuses a cancelled caller even if the core ignores cancellation and answers', async () => {
    const f = connectionReplyFixture()
    const caller = new AbortController()
    const pending = f.owner.connect(serviceId, pairId, caller.signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    const accepted = await f.dispatch
    caller.abort()
    f.answer(accepted)
    await refused
    expect(f.owner.connections().peers).toEqual([])
  })

  it('rechecks caller cancellation after asynchronous publication authorization', async () => {
    const f = connectionReplyFixture()
    const caller = new AbortController()
    const pending = f.owner.connect(serviceId, pairId, caller.signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.request_cancelled' })
    const accepted = await f.dispatch
    let reading!: () => void
    const readStarted = new Promise<void>((resolve) => (reading = resolve))
    let release!: () => void
    f.inspect.mockImplementationOnce(() => {
      reading()
      return new Promise((resolve) => {
        release = () => resolve({ revision: 'f'.repeat(64), record: structuredClone(f.record()) })
      })
    })
    f.answer(accepted)
    await readStarted
    caller.abort()
    release()
    await refused
    expect(f.owner.connections().peers).toEqual([])
  })

  it('fences catalog removal even when publication authorization already read the old record', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.stale_generation' })
    const accepted = await f.dispatch
    const old = structuredClone(f.record())
    let reading!: () => void
    const readStarted = new Promise<void>((resolve) => (reading = resolve))
    let release!: () => void
    f.inspect.mockImplementationOnce(() => {
      reading()
      return new Promise((resolve) => {
        release = () => resolve({ revision: 'f'.repeat(64), record: old })
      })
    })
    f.answer(accepted)
    await readStarted
    await f.owner.removeService(serviceId, signal())
    release()
    await refused
    expect(f.owner.connections().peers).toEqual([])
  })

  it('cannot publish from a session whose core channel became unavailable', async () => {
    const f = connectionReplyFixture()
    const pending = f.owner.connect(serviceId, pairId, signal())
    const refused = expect(pending).rejects.toMatchObject({ code: 'p2p.helper_closed' })
    const accepted = await f.dispatch
    f.unavailable()
    f.answer(accepted)
    await refused
    expect(f.owner.connections().peers).toEqual([])
    expect(f.owner.connections().error).toBe('p2p.helper_unavailable')
  })

  it.each([
    { changedService: serviceId, afterInspect: false, expectedCode: 'p2p.stale_generation' },
    { changedService: serviceId, afterInspect: true, expectedCode: 'p2p.stale_generation' },
    { changedService: 'c'.repeat(12), afterInspect: false, expectedCode: undefined }
  ])(
    'fences only the changed service through the final commit (service=$changedService, afterInspect=$afterInspect)',
    async ({ changedService, afterInspect, expectedCode }) => {
      const f = connectionReplyFixture()
      const pending = f.owner.connect(serviceId, pairId, signal())
      const outcome = expectedCode
        ? expect(pending).rejects.toMatchObject({ code: expectedCode })
        : expect(pending).resolves.toMatchObject({ pairId, stage: 'punching' })
      const accepted = await f.dispatch
      const old = structuredClone(f.record())
      let reading!: () => void
      const readStarted = new Promise<void>((resolve) => (reading = resolve))
      let release!: () => void
      f.inspect.mockImplementationOnce(() => {
        reading()
        return new Promise((resolve) => {
          release = () => resolve({ revision: 'f'.repeat(64), record: old })
        })
      })
      f.answer(accepted)
      await readStarted
      if (expectedCode) for (const computer of f.record().computers) computer.pairState = 'revoked'
      const announcement = { serviceId: changedService, revision: '1'.repeat(64) }
      if (afterInspect) {
        release()
        // inspect has resolved: #authorize resumes first, then this announcement,
        // then its caller's commit. The returned authorization fence must hold.
        await Promise.resolve().then(() => f.catalogChanged(announcement))
      } else {
        await f.catalogChanged(announcement)
        release()
      }
      await outcome
      expect(f.owner.connections().peers).toEqual(
        expectedCode ? [] : [{ serviceId, state: accepted }]
      )
    }
  )
})
