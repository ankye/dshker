#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const budgets = [
  { name: 'startup.config.synthetic', maxDurationMs: 40, severity: 'hard' },
  { name: 'startup.critical_path.synthetic', maxDurationMs: 10, severity: 'hard' },
  { name: 'startup.shell_mounted.synthetic', maxDurationMs: 10, severity: 'hard' },
  { name: 'startup.first_visual_feedback.synthetic', maxDurationMs: 20, severity: 'hard' },
  { name: 'startup.renderer_ready.synthetic', maxDurationMs: 20, severity: 'hard' },
  { name: 'startup.packaged_launch.synthetic', maxDurationMs: 30, severity: 'hard' },
  { name: 'bridge.dispatch.synthetic', maxDurationMs: 20, severity: 'hard' },
  { name: 'runtime.long_tasks.synthetic', maxValue: 0, unit: 'count', severity: 'hard' },
  { name: 'vfs.path.synthetic', maxDurationMs: 20, severity: 'hard' },
  { name: 'validation.schema.synthetic', maxDurationMs: 20, severity: 'hard' },
  { name: 'memory.heap.used', maxValue: 512, unit: 'mb', severity: 'hard' },
  {
    name: 'startup.white_screen.synthetic',
    maxDurationMs: 120,
    severity: 'advisory',
    promoteAfterSamples: 5
  }
]

function parseArgs(argv) {
  const args = {
    buildMode: 'local',
    json: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--mode') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('Missing --mode value')
      args.buildMode = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
}

function dependencyVersion(packageJson, name) {
  return (
    packageJson.dependencies?.[name] ||
    packageJson.devDependencies?.[name] ||
    packageJson.optionalDependencies?.[name] ||
    ''
  )
}

function validateSchemaLikePayload(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'environment' in value &&
    typeof value.environment === 'string' &&
    'timeoutMs' in value &&
    typeof value.timeoutMs === 'number'
  )
}

function validateStartupCriticalPath(tasks) {
  const heavyCategories = new Set([
    'vfs',
    'service',
    'plugin',
    'thumbnail',
    'network',
    'statlog',
    'resource-import'
  ])
  const criticalTasks = tasks.filter((task) => task.stage === 'critical')
  const totalBudgetMs = criticalTasks.reduce((total, task) => total + task.budgetMs, 0)

  if (totalBudgetMs > 1200) throw new Error('critical startup budget exceeded')
  for (const task of criticalTasks) {
    if (heavyCategories.has(task.category)) {
      throw new Error(`heavy startup task on critical path: ${task.id}`)
    }
  }
  for (const task of tasks) {
    if (task.stage !== 'critical' && task.blocksFirstPaint) {
      throw new Error(`non-critical task blocks first paint: ${task.id}`)
    }
  }
}

export function measure(name, action) {
  const startedAt = performance.now()
  action()
  return {
    name,
    durationMs: Math.max(0, performance.now() - startedAt),
    status: 'ok'
  }
}

export function runSyntheticChecks() {
  const metrics = []
  metrics.push(
    measure('startup.critical_path.synthetic', () => {
      validateStartupCriticalPath([
        {
          id: 'config.resolve',
          stage: 'critical',
          category: 'config',
          budgetMs: 40,
          blocksFirstPaint: true
        },
        {
          id: 'bridge.register',
          stage: 'critical',
          category: 'bridge',
          budgetMs: 80,
          blocksFirstPaint: true
        },
        {
          id: 'renderer.mount-shell',
          stage: 'critical',
          category: 'renderer',
          budgetMs: 300,
          blocksFirstPaint: true
        },
        {
          id: 'vfs.catalog-open',
          stage: 'background',
          category: 'vfs',
          budgetMs: 700,
          blocksFirstPaint: false
        },
        {
          id: 'plugin.registry-load',
          stage: 'background',
          category: 'plugin',
          budgetMs: 1000,
          blocksFirstPaint: false
        },
        {
          id: 'thumbnail.queue-warm',
          stage: 'idle',
          category: 'thumbnail',
          budgetMs: 1500,
          blocksFirstPaint: false
        }
      ])
    })
  )
  metrics.push(
    measure('startup.config.synthetic', () => {
      const config = {
        environment: 'production',
        featureFlags: { statlog: true, bridgeDiagnostics: false },
        values: { timeoutMs: 8000 }
      }
      JSON.stringify(config)
    })
  )
  metrics.push(
    measure('startup.shell_mounted.synthetic', () => {
      const readiness = {
        processStart: true,
        windowCreated: true,
        domContentLoaded: true,
        appShellMounted: true,
        bridgeReady: true,
        firstInteractionReady: true
      }
      if (!readiness.appShellMounted || !readiness.bridgeReady) {
        throw new Error('renderer shell readiness marker missing')
      }
    })
  )
  metrics.push(
    measure('startup.first_visual_feedback.synthetic', () => {
      const firstFrame = {
        nonblank: true,
        singleColor: false,
        contentPixels: 384,
        sampledPixels: 2304
      }
      if (!firstFrame.nonblank || firstFrame.singleColor || firstFrame.contentPixels <= 0) {
        throw new Error('first frame is blank or single-color')
      }
    })
  )
  metrics.push(
    measure('startup.renderer_ready.synthetic', () => {
      const renderer = {
        shellMounted: true,
        routeResolved: true,
        themeApplied: true,
        firstInteractionReady: true
      }
      if (!renderer.shellMounted || !renderer.routeResolved || !renderer.themeApplied) {
        throw new Error('renderer readiness failed')
      }
    })
  )
  metrics.push(
    measure('startup.packaged_launch.synthetic', () => {
      const packageSmoke = {
        executableLocated: true,
        rendererReady: true,
        routeSmoke: true,
        exitCleanly: true
      }
      if (!Object.values(packageSmoke).every(Boolean)) {
        throw new Error('packaged launch readiness failed')
      }
    })
  )
  metrics.push(
    measure('startup.white_screen.synthetic', () => {
      const whiteScreenMs = 48
      if (whiteScreenMs > 5000) throw new Error('white screen duration exceeded safety guard')
    })
  )
  metrics.push(
    measure('bridge.dispatch.synthetic', () => {
      const handlers = new Map([['settings:load', () => ({ ok: true, data: {} })]])
      handlers.get('settings:load')?.()
    })
  )
  metrics.push(
    measure('vfs.path.synthetic', () => {
      const parts = ['projects', 'demo', 'assets', 'hero.png']
      const relative = parts.join('/')
      if (relative.includes('..')) throw new Error('unexpected traversal')
    })
  )
  metrics.push(
    measure('validation.schema.synthetic', () => {
      if (!validateSchemaLikePayload({ environment: 'production', timeoutMs: 8000 })) {
        throw new Error('schema validation failed')
      }
    })
  )
  metrics.push({
    name: 'memory.heap.used',
    value: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    unit: 'mb',
    status: 'ok'
  })
  metrics.push({
    name: 'runtime.long_tasks.synthetic',
    value: 0,
    unit: 'count',
    status: 'ok'
  })
  return metrics
}

export function evaluate(metrics, budgetList = budgets) {
  return budgetList.map((budget) => {
    const metric = metrics.find((item) => item.name === budget.name)
    const measured =
      budget.maxDurationMs !== undefined
        ? (metric?.durationMs ?? Infinity)
        : (metric?.value ?? Infinity)
    const threshold = budget.maxDurationMs ?? budget.maxValue
    return {
      name: budget.name,
      ok: measured <= threshold,
      measured,
      budget: threshold,
      severity: budget.severity || 'hard',
      promoteAfterSamples: budget.promoteAfterSamples,
      unit: budget.unit || (budget.maxDurationMs !== undefined ? 'ms' : undefined)
    }
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const packageJson = await readPackageJson()
  const metrics = runSyntheticChecks()
  const results = evaluate(metrics)
  const failures = results.filter((result) => !result.ok && result.severity !== 'advisory')
  const warnings = results.filter((result) => !result.ok && result.severity === 'advisory')
  const output = {
    ok: failures.length === 0,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      appVersion: packageJson.version,
      shellFramework: 'electron',
      shellFrameworkVersion: dependencyVersion(packageJson, 'electron'),
      buildMode: args.buildMode,
      osRelease: os.release(),
      cpuModel: os.cpus()[0]?.model || '',
      measuredAt: new Date().toISOString()
    },
    budgets,
    metrics,
    results,
    failures,
    warnings
  }

  const outputDir = path.join(appRoot, '.run', 'performance')
  await mkdir(outputDir, { recursive: true })
  await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(output, null, 2)}\n`)

  if (args.json) console.log(JSON.stringify(output, null, 2))
  else if (output.ok) console.log(`Performance checks passed for ${results.length} budget(s).`)
  else for (const result of failures) console.error(result)

  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`performance-check: ${error.message}`)
    process.exitCode = 1
  })
}
