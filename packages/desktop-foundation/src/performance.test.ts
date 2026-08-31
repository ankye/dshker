import { describe, expect, it } from 'vitest'
import {
  createPerformanceProbe,
  evaluatePerformanceBudgets,
  getBenchmarkEnvironment
} from './performance'

describe('performance foundation', () => {
  it('records sanitized sync, async, and memory performance metrics', async () => {
    const probe = createPerformanceProbe(() => 2000)

    expect(
      probe.measure(
        {
          name: 'bridge.latency',
          category: 'bridge',
          context: { token: 'secret-token', channel: 'settings.load' }
        },
        () => ({ ok: true as const, data: 1 })
      )
    ).toEqual({ ok: true, data: 1 })

    await expect(
      probe.measureAsync({ name: 'vfs.read', category: 'vfs' }, async () => ({
        ok: false as const,
        error: { code: 'vfs.not_found', message: 'missing' }
      }))
    ).resolves.toMatchObject({ ok: false })
    probe.memory()

    expect(probe.snapshot()).toEqual([
      expect.objectContaining({
        name: 'bridge.latency',
        category: 'bridge',
        status: 'ok',
        measuredAtMs: 2000,
        context: { token: '[redacted]', channel: 'settings.load' }
      }),
      expect.objectContaining({
        name: 'vfs.read',
        category: 'vfs',
        status: 'error',
        errorCode: 'vfs.not_found'
      }),
      expect.objectContaining({
        name: 'memory.heap_used',
        category: 'memory',
        unit: 'bytes',
        status: 'ok'
      })
    ])
  })

  it('evaluates p95 performance budgets and benchmark metadata', () => {
    const results = evaluatePerformanceBudgets(
      [
        {
          name: 'startup.ready',
          category: 'startup',
          durationMs: 10,
          status: 'ok',
          measuredAtMs: 1
        },
        {
          name: 'startup.ready',
          category: 'startup',
          durationMs: 20,
          status: 'ok',
          measuredAtMs: 2
        }
      ],
      [{ name: 'startup.ready', maxDurationMs: 25 }]
    )

    expect(results).toEqual([
      {
        ok: true,
        name: 'startup.ready',
        measured: 20,
        budget: 25,
        unit: 'ms',
        sampleCount: 2
      }
    ])
    expect(getBenchmarkEnvironment(() => 3000).measuredAtMs).toBe(3000)
  })
})
