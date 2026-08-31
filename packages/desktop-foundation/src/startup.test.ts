import { describe, expect, it } from 'vitest'
import {
  DESKTOP_TEMPLATE_STARTUP_PLAN,
  groupStartupTasksByStage,
  validateStartupPlan,
  type StartupTask
} from './startup'

describe('startup planning', () => {
  it('keeps the template critical path lightweight', () => {
    const validation = validateStartupPlan(DESKTOP_TEMPLATE_STARTUP_PLAN)

    expect(validation.ok).toBe(true)
    expect(validation.totals.critical).toBeLessThanOrEqual(1200)
    expect(
      groupStartupTasksByStage(DESKTOP_TEMPLATE_STARTUP_PLAN).critical.map((task) => task.id)
    ).toEqual(['config.resolve', 'bridge.register', 'renderer.mount-shell'])
  })

  it('rejects heavy or blocking work on the first-paint path', () => {
    const slowPlan: StartupTask[] = [
      {
        id: 'vfs.scan-all',
        label: 'Scan all files',
        stage: 'critical',
        category: 'vfs',
        budgetMs: 2000,
        blocksFirstPaint: true
      },
      {
        id: 'plugin.load',
        label: 'Load plugins',
        stage: 'background',
        category: 'plugin',
        budgetMs: 500,
        blocksFirstPaint: true
      }
    ]

    expect(validateStartupPlan(slowPlan)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'startup.heavy_task_on_critical_path' }),
        expect.objectContaining({ code: 'startup.noncritical_blocks_first_paint' }),
        expect.objectContaining({ code: 'startup.critical_budget_exceeded' })
      ])
    })
  })
})
