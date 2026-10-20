import { describe, expect, it, vi } from 'vitest'
import { fixture, serviceId, user } from './tests/management-fixture'
import { PeerHelperError } from './wire'

vi.mock('electron', () => ({ safeStorage: {} }))

const otherServiceId = '9'.repeat(12)
const terminalPair = '2'.repeat(12)
const transientPair = '6'.repeat(12)

async function refusedServices() {
  const f = fixture()
  await f.owner.login(serviceId, user.username, 'test-password', new AbortController().signal)
  const record = f.record()
  record.services.push({ ...record.services[0]!, serviceId: otherServiceId })
  record.computers.push({
    ...record.computers[0]!,
    serviceId: otherServiceId,
    connectionId: '9'.repeat(12)
  })
  const base = f.call.getMockImplementation()
  if (!base) throw new Error('The management fixture has no core dispatcher')
  const attempts = new Map<string, number>()
  f.call.mockImplementation(async (method, payload, signal) => {
    if (method !== 'peer.connect') return base(method, payload, signal)
    const scope = payload as { serviceId: string; data: { pairId: string } }
    const key = `${scope.serviceId}:${scope.data.pairId}`
    const count = (attempts.get(key) ?? 0) + 1
    attempts.set(key, count)
    if (scope.data.pairId === terminalPair) throw new PeerHelperError('p2p.pair_unauthorized')
    if (count === 1) throw new PeerHelperError('p2p.peer_offline')
    return {}
  })
  // Establish the core's existing refusals before delivering real shell callbacks.
  for (const id of [serviceId, otherServiceId])
    await f.call(
      'peer.autoconnect_reconcile',
      { serviceId: id, data: {} },
      new AbortController().signal
    )
  expect(attempts.get(`${serviceId}:${terminalPair}`)).toBe(1)
  expect(attempts.get(`${otherServiceId}:${terminalPair}`)).toBe(1)
  f.call.mockClear()
  return { ...f, attempts }
}

async function maintenanceSettled(f: Awaited<ReturnType<typeof refusedServices>>, count: number) {
  await vi.waitFor(() => {
    expect(
      f.call.mock.calls.filter(([method]) => method.startsWith('peer.autoconnect_'))
    ).toHaveLength(count)
  })
  await Promise.all(
    f.call.mock.calls.flatMap(([method], index) =>
      method.startsWith('peer.autoconnect_') ? [f.call.mock.results[index]!.value] : []
    )
  )
}

describe('shell maintenance preserves terminal authorization', () => {
  it('reconciles catalog A without clearing terminal A or B', async () => {
    const f = await refusedServices()
    await f.catalogChanged({ serviceId, revision: 'c'.repeat(64) })
    await maintenanceSettled(f, 1)
    expect(f.call.mock.calls.filter(([method]) => method.startsWith('peer.autoconnect_'))).toEqual([
      ['peer.autoconnect_reconcile', { serviceId, data: {} }, expect.any(AbortSignal)]
    ])
    // A later B sweep must still see B's original terminal rather than redial it.
    await f.call(
      'peer.autoconnect_reconcile',
      { serviceId: otherServiceId, data: {} },
      new AbortController().signal
    )
    expect(f.attempts.get(`${serviceId}:${terminalPair}`)).toBe(1)
    expect(f.attempts.get(`${otherServiceId}:${terminalPair}`)).toBe(1)
  })

  it('ordinary resume retries transient work while preserving terminal A and B', async () => {
    const f = await refusedServices()
    f.owner.resumeConnectivity()
    await vi.waitFor(() => {
      const retried = f.call.mock.calls
        .filter(([method]) => method === 'peer.autoconnect_retry_now')
        .map(([, payload]) => (payload as { serviceId: string }).serviceId)
      expect(new Set(retried)).toEqual(new Set([serviceId, otherServiceId]))
    })
    const maintenance = f.call.mock.calls.flatMap(([method], index) =>
      method.startsWith('peer.autoconnect_') ? [index] : []
    )
    await Promise.all(maintenance.map((index) => f.call.mock.results[index]!.value))
    for (const index of maintenance) {
      const [method, payload] = f.call.mock.calls[index]!
      // The concurrent session sweep can also reconcile restored accounts.
      expect(['peer.autoconnect_reconcile', 'peer.autoconnect_retry_now']).toContain(method)
      expect(f.call.mock.calls[index]).toEqual([
        method,
        { serviceId: (payload as { serviceId: string }).serviceId, data: {} },
        expect.any(AbortSignal)
      ])
      expect([serviceId, otherServiceId]).toContain((payload as { serviceId: string }).serviceId)
    }
    expect(f.attempts.get(`${serviceId}:${terminalPair}`)).toBe(1)
    expect(f.attempts.get(`${otherServiceId}:${terminalPair}`)).toBe(1)
    expect(f.attempts.get(`${serviceId}:${transientPair}`)).toBeGreaterThan(1)
  })
})
