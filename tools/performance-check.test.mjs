import { describe, expect, it } from 'vitest'
import { evaluate } from './performance-check.mjs'

describe('performance budget evaluation', () => {
  it('passes values under hard budgets', () => {
    const results = evaluate(
      [
        { name: 'startup.renderer_ready.synthetic', durationMs: 8 },
        { name: 'memory.heap.used', value: 128 }
      ],
      [
        { name: 'startup.renderer_ready.synthetic', maxDurationMs: 20, severity: 'hard' },
        { name: 'memory.heap.used', maxValue: 512, unit: 'mb', severity: 'hard' }
      ]
    )
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('reports hard budget failures', () => {
    const results = evaluate(
      [{ name: 'startup.first_visual_feedback.synthetic', durationMs: 80 }],
      [{ name: 'startup.first_visual_feedback.synthetic', maxDurationMs: 20, severity: 'hard' }]
    )
    expect(results[0]).toMatchObject({
      ok: false,
      severity: 'hard',
      measured: 80,
      budget: 20
    })
  })

  it('keeps advisory budget failures advisory', () => {
    const results = evaluate(
      [{ name: 'startup.white_screen.synthetic', durationMs: 180 }],
      [
        {
          name: 'startup.white_screen.synthetic',
          maxDurationMs: 120,
          severity: 'advisory',
          promoteAfterSamples: 5
        }
      ]
    )
    expect(results[0]).toMatchObject({
      ok: false,
      severity: 'advisory',
      promoteAfterSamples: 5
    })
  })

  it('fails missing hard metrics', () => {
    const results = evaluate([], [{ name: 'bridge.dispatch.synthetic', maxDurationMs: 20 }])
    expect(results[0].ok).toBe(false)
    expect(results[0].measured).toBe(Infinity)
  })
})
