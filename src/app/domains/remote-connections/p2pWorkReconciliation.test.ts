import { describe, expect, it, vi } from 'vitest'
import type { P2PConnectionView, P2PManagementApi } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PConnectionsDomain } from './p2pConnections'
import { P2PWorkReconciliationDomain } from './p2pWorkReconciliation'

const serviceId = 'service-a'
const pairId = 'pair-a'

function peer(
  stage: P2PConnectionView['stage'],
  overrides: Partial<P2PConnectionView> = {}
): P2PConnectionView {
  return {
    serviceId,
    pairId,
    attemptId: 'attempt-1',
    generation: 4,
    stage,
    error: stage === 'failed' ? 'p2p.direct_closed' : '',
    path:
      stage === 'ready'
        ? { localType: 'host', remoteType: 'srflx', protocol: 'udp' }
        : { localType: '', remoteType: '', protocol: '' },
    runtimeGeneration: stage === 'ready' ? 7 : 0,
    ...overrides
  }
}

async function setup(peers: P2PConnectionView[]) {
  const api = {
    connections: vi
      .fn<P2PManagementApi['connections']>()
      .mockResolvedValue({ ok: true, data: { error: '', peers } })
  }
  const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
  const connections = new P2PConnectionsDomain(management)
  await connections.read()
  return { api, connections, work: new P2PWorkReconciliationDomain(connections) }
}

/** Replaces the live snapshot to simulate what the next readback observes. */
async function observe(
  ctx: Awaited<ReturnType<typeof setup>>,
  peers: P2PConnectionView[]
): Promise<void> {
  ctx.api.connections.mockResolvedValue({ ok: true, data: { error: '', peers } })
  await ctx.connections.read()
}

describe('remote work reconciliation after a disconnect', () => {
  it('reports nothing to reconcile before any work starts', async () => {
    const ctx = await setup([peer('ready')])
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'connected' })
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(false)
  })

  it('refuses to note work on an attempt that never became ready', async () => {
    const ctx = await setup([peer('punching')])
    expect(ctx.work.noteWorkStarted(serviceId, pairId)).toBe(false)
    expect(ctx.work.record(serviceId, pairId)).toBeUndefined()
  })

  it('distinguishes a lost connection from a stopped task', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('disconnected')])
    // Losing the transport says nothing about whether the task kept running.
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'connection_lost' })
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(true)
  })

  it('reports an unknown outcome when the connection failed outright', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('failed')])
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'work_unknown' })
  })

  it('keeps the outcome unknown while a new attempt is still negotiating', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    for (const stage of ['punching', 'starting-runtime'] as const) {
      await observe(ctx, [peer(stage, { attemptId: 'attempt-2', generation: 5 })])
      expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'work_unknown' })
    }
  })

  it('treats a peer that vanished from the snapshot as a lost connection', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [])
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'connection_lost' })
  })

  it('reports the same runtime as still connected after an uninterrupted read', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('ready')])
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'connected' })
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(false)
  })

  it('flags a replaced runtime rather than claiming the old work survived', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [
      peer('ready', { attemptId: 'attempt-2', generation: 5, runtimeGeneration: 8 })
    ])
    expect(ctx.work.verdict(serviceId, pairId)).toEqual({ kind: 'runtime_replaced' })
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(true)
  })

  it('does not clear the warning merely because the peer reconnected', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('disconnected')])
    await observe(ctx, [
      peer('ready', { attemptId: 'attempt-3', generation: 6, runtimeGeneration: 9 })
    ])
    // Reconnecting is not evidence about the earlier task.
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(true)
  })

  it('clears the warning only after the user confirms the remote outcome', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('disconnected')])
    ctx.work.markReconciled(serviceId, pairId)
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(false)
  })

  it('never resubmits or cancels anything while reconciling', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('failed')])
    ctx.work.verdict(serviceId, pairId)
    ctx.work.needsAttention(serviceId, pairId)
    // Only reads occurred; no connect, disconnect or task call was made.
    expect(Object.keys(ctx.api)).toEqual(['connections'])
  })

  it('keeps two computers independent', async () => {
    const other = { ...peer('ready'), pairId: 'pair-b' }
    const ctx = await setup([peer('ready'), other])
    ctx.work.noteWorkStarted(serviceId, pairId)
    await observe(ctx, [peer('failed'), other])
    expect(ctx.work.needsAttention(serviceId, pairId)).toBe(true)
    expect(ctx.work.needsAttention(serviceId, 'pair-b')).toBe(false)
  })

  it('forgets tracking when the pair is dropped', async () => {
    const ctx = await setup([peer('ready')])
    ctx.work.noteWorkStarted(serviceId, pairId)
    ctx.work.forget(serviceId, pairId)
    expect(ctx.work.record(serviceId, pairId)).toBeUndefined()
  })
})
