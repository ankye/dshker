export type StartupStage = 'critical' | 'interactive' | 'background' | 'idle'

export type StartupTaskCategory =
  | 'config'
  | 'shell'
  | 'renderer'
  | 'bridge'
  | 'settings'
  | 'vfs'
  | 'service'
  | 'plugin'
  | 'thumbnail'
  | 'network'
  | 'statlog'
  | 'resource-import'
  | (string & {})

export interface StartupTask {
  id: string
  label: string
  stage: StartupStage
  category: StartupTaskCategory
  budgetMs: number
  blocksFirstPaint: boolean
}

export interface StartupBudgetPolicy {
  criticalTotalMs: number
  interactiveTotalMs: number
  maxCriticalTaskMs: number
  heavyCategories: StartupTaskCategory[]
}

export interface StartupPlanIssue {
  severity: 'error' | 'warning'
  code: string
  taskId?: string
  message: string
}

export interface StartupPlanValidation {
  ok: boolean
  issues: StartupPlanIssue[]
  totals: Record<StartupStage, number>
}

export const DEFAULT_STARTUP_BUDGET_POLICY: StartupBudgetPolicy = {
  criticalTotalMs: 1200,
  interactiveTotalMs: 2500,
  maxCriticalTaskMs: 300,
  heavyCategories: [
    'vfs',
    'service',
    'plugin',
    'thumbnail',
    'network',
    'statlog',
    'resource-import'
  ]
}

export const DESKTOP_TEMPLATE_STARTUP_PLAN: StartupTask[] = [
  {
    id: 'config.resolve',
    label: 'Resolve runtime config',
    stage: 'critical',
    category: 'config',
    budgetMs: 40,
    blocksFirstPaint: true
  },
  {
    id: 'bridge.register',
    label: 'Register bridge handlers',
    stage: 'critical',
    category: 'bridge',
    budgetMs: 80,
    blocksFirstPaint: true
  },
  {
    id: 'renderer.mount-shell',
    label: 'Mount app shell',
    stage: 'critical',
    category: 'renderer',
    budgetMs: 300,
    blocksFirstPaint: true
  },
  {
    id: 'settings.load',
    label: 'Load persisted settings',
    stage: 'interactive',
    category: 'settings',
    budgetMs: 150,
    blocksFirstPaint: false
  },
  {
    id: 'vfs.catalog-open',
    label: 'Open VFS catalog',
    stage: 'background',
    category: 'vfs',
    budgetMs: 700,
    blocksFirstPaint: false
  },
  {
    id: 'plugin.registry-load',
    label: 'Load asset parser plugins',
    stage: 'background',
    category: 'plugin',
    budgetMs: 1000,
    blocksFirstPaint: false
  },
  {
    id: 'asset-service.connect',
    label: 'Connect optional asset service',
    stage: 'background',
    category: 'service',
    budgetMs: 800,
    blocksFirstPaint: false
  },
  {
    id: 'thumbnail.queue-warm',
    label: 'Warm thumbnail queue',
    stage: 'idle',
    category: 'thumbnail',
    budgetMs: 1500,
    blocksFirstPaint: false
  }
]

const STAGES: StartupStage[] = ['critical', 'interactive', 'background', 'idle']

function emptyTotals(): Record<StartupStage, number> {
  return {
    critical: 0,
    interactive: 0,
    background: 0,
    idle: 0
  }
}

function isHeavyCategory(category: StartupTaskCategory, policy: StartupBudgetPolicy): boolean {
  return policy.heavyCategories.includes(category)
}

export function groupStartupTasksByStage(
  tasks: StartupTask[]
): Record<StartupStage, StartupTask[]> {
  return STAGES.reduce(
    (groups, stage) => ({
      ...groups,
      [stage]: tasks.filter((task) => task.stage === stage)
    }),
    {
      critical: [],
      interactive: [],
      background: [],
      idle: []
    } as Record<StartupStage, StartupTask[]>
  )
}

export function validateStartupPlan(
  tasks: StartupTask[],
  policy: StartupBudgetPolicy = DEFAULT_STARTUP_BUDGET_POLICY
): StartupPlanValidation {
  const totals = emptyTotals()
  const issues: StartupPlanIssue[] = []
  const seen = new Set<string>()

  for (const task of tasks) {
    totals[task.stage] += task.budgetMs

    if (seen.has(task.id)) {
      issues.push({
        severity: 'error',
        code: 'startup.duplicate_task',
        taskId: task.id,
        message: `Duplicate startup task id: ${task.id}`
      })
    }
    seen.add(task.id)

    if (task.budgetMs < 0) {
      issues.push({
        severity: 'error',
        code: 'startup.invalid_budget',
        taskId: task.id,
        message: `Startup task ${task.id} has a negative budget.`
      })
    }

    if (task.stage !== 'critical' && task.blocksFirstPaint) {
      issues.push({
        severity: 'error',
        code: 'startup.noncritical_blocks_first_paint',
        taskId: task.id,
        message: `Startup task ${task.id} blocks first paint but is not in the critical stage.`
      })
    }

    if (task.stage === 'critical' && isHeavyCategory(task.category, policy)) {
      issues.push({
        severity: 'error',
        code: 'startup.heavy_task_on_critical_path',
        taskId: task.id,
        message: `Startup task ${task.id} uses heavy category ${task.category} on the critical path.`
      })
    }

    if (task.stage === 'critical' && task.budgetMs > policy.maxCriticalTaskMs) {
      issues.push({
        severity: 'warning',
        code: 'startup.critical_task_budget_high',
        taskId: task.id,
        message: `Startup task ${task.id} exceeds the per-task critical startup budget.`
      })
    }
  }

  if (totals.critical > policy.criticalTotalMs) {
    issues.push({
      severity: 'error',
      code: 'startup.critical_budget_exceeded',
      message: `Critical startup budget is ${totals.critical}ms, above ${policy.criticalTotalMs}ms.`
    })
  }

  if (totals.critical + totals.interactive > policy.interactiveTotalMs) {
    issues.push({
      severity: 'warning',
      code: 'startup.interactive_budget_high',
      message: `Interactive startup budget is ${
        totals.critical + totals.interactive
      }ms, above ${policy.interactiveTotalMs}ms.`
    })
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    issues,
    totals
  }
}
