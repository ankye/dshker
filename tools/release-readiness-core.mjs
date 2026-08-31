import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const defaultStages = [
  {
    id: 'environment-check',
    label: 'Environment versions',
    command: 'npm',
    args: ['run', 'environment:check', '--', '--json'],
    hardGate: true
  },
  {
    id: 'architecture-check',
    label: 'Architecture boundaries',
    command: 'npm',
    args: ['run', 'architecture:check', '--', '--json'],
    hardGate: true
  },
  {
    id: 'format-check',
    label: 'Format check',
    command: 'npm',
    args: ['run', 'format:check'],
    hardGate: true
  },
  {
    id: 'type-check',
    label: 'Type check',
    command: 'npm',
    args: ['run', 'type-check'],
    hardGate: true
  },
  {
    id: 'unit-tests',
    label: 'Unit tests',
    command: 'npm',
    args: ['test', '--', '--run'],
    hardGate: true
  },
  {
    id: 'e2e-tests',
    label: 'E2E tests',
    command: 'npm',
    args: ['run', 'test:e2e'],
    hardGate: true
  },
  {
    id: 'service-smoke',
    label: 'Node service smoke',
    command: 'npm',
    args: ['run', 'service:smoke'],
    hardGate: true
  },
  {
    id: 'visual-smoke',
    label: 'Visual smoke',
    command: 'npm',
    args: ['run', 'visual:smoke'],
    hardGate: true,
    evidence: '.run/visual-smoke/latest.json'
  },
  {
    id: 'performance-check',
    label: 'Performance budgets',
    command: 'npm',
    args: ['run', 'performance:check', '--', '--mode', 'release-readiness', '--json'],
    hardGate: true,
    evidence: '.run/performance/latest.json'
  },
  {
    id: 'package',
    label: 'Package current platform',
    command: 'npm',
    args: ['run', 'package'],
    hardGate: true,
    evidence: 'release/release-manifest.json'
  },
  {
    id: 'release-verify',
    label: 'Release metadata verify',
    command: 'npm',
    args: ['run', 'release:verify'],
    hardGate: true
  },
  {
    id: 'release-smoke',
    label: 'Packaged app smoke',
    command: 'npm',
    args: ['run', 'release:smoke'],
    hardGate: true
  }
]

const templatePackageStage = {
  id: 'template-package-contract',
  label: 'Template package contract smoke',
  command: 'node',
  args: ['tools/template-package-smoke.mjs', '--json'],
  hardGate: true,
  evidence: '.run/release-readiness/template-package-smoke.json'
}

export function npmCommand() {
  return 'npm'
}

export function npmStage(commandArgs) {
  if (process.platform !== 'win32') return { command: npmCommand(), args: commandArgs }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', npmCommand(), ...commandArgs]
  }
}

export function normalizeStage(stage) {
  if (stage.command === 'npm') {
    const npm = npmStage(stage.args)
    return {
      ...stage,
      command: npm.command,
      args: npm.args
    }
  }
  if (stage.command === 'node') {
    return {
      ...stage,
      command: process.execPath
    }
  }
  return {
    ...stage
  }
}

export function createReadinessPlan(options = {}) {
  const skip = new Set(options.skipStages || [])
  const stages = options.templateMode
    ? [
        ...defaultStages.filter(
          (stage) => !['package', 'release-verify', 'release-smoke'].includes(stage.id)
        ),
        templatePackageStage
      ]
    : defaultStages
  return stages.filter((stage) => !skip.has(stage.id)).map(normalizeStage)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceAllPathForms(text, target, replacement) {
  if (!target) return text
  const forms = new Set([target, target.replaceAll('\\', '/'), target.replaceAll('/', '\\')])
  return [...forms].reduce(
    (current, form) => current.replace(new RegExp(escapeRegExp(form), 'gi'), replacement),
    text
  )
}

export function redactText(value, context = {}) {
  let text = String(value ?? '')
  text = replaceAllPathForms(text, context.appRoot, '<app-root>')
  text = replaceAllPathForms(text, os.homedir(), '<home>')
  text = text.replace(/(^|[^A-Za-z])([A-Za-z]:[\\/][^\s"'<>]+)/g, '$1<absolute-path>')
  text = text.replace(/\/Users\/[^/\s"'<>]+(?:\/[^\s"'<>]+)*/g, '<home-path>')
  text = text.replace(/\/home\/[^/\s"'<>]+(?:\/[^\s"'<>]+)*/g, '<home-path>')
  text = text.replace(/\\\\[A-Za-z0-9._-]+\\[^\s"'<>]+/g, '<network-path>')
  text = text.replace(/sk-[A-Za-z0-9_-]{20,}/g, '<secret>')
  text = text.replace(
    /\b(api[_-]?key|token|secret|password|credential|certificate|notarization)[\w.-]*\s*[:=]\s*["']?[^"'\s,}]+/gi,
    '$1=<redacted>'
  )
  return text
}

export function redactValue(value, context = {}) {
  if (typeof value === 'string') return redactText(value, context)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, context))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|credential|certificate|notarization|apiKey/i.test(key)
          ? '<redacted>'
          : redactValue(item, context)
      ])
    )
  }
  return value
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJsonIfExists(filePath) {
  if (!(await exists(filePath))) return null
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function execVersion(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: 10000,
      windowsHide: true
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function npmVersion(cwd) {
  const npm = npmStage(['--version'])
  return execVersion(npm.command, npm.args, cwd)
}

async function gitRevision(cwd) {
  return execVersion('git', ['rev-parse', '--short', 'HEAD'], cwd)
}

async function readTemplateId(appRoot) {
  const metadata = await readJsonIfExists(path.resolve(appRoot, '..', 'template.json'))
  return metadata?.id || 'generated-app'
}

async function collectMetadata(appRoot) {
  const packageJson = await readJsonIfExists(path.join(appRoot, 'package.json'))
  return {
    templateId: await readTemplateId(appRoot),
    appId: packageJson?.build?.appId || packageJson?.name || '',
    appName: packageJson?.build?.productName || packageJson?.name || '',
    appVersion: packageJson?.version || '',
    packageName: packageJson?.name || '',
    gitRevision: await gitRevision(appRoot),
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    packageManager: {
      npm: await npmVersion(appRoot)
    },
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model || ''
  }
}

async function isTemplateSource(appRoot) {
  const packageJson = await readJsonIfExists(path.join(appRoot, 'package.json'))
  return JSON.stringify(packageJson || {}).includes('__APP_')
}

export function commandLine(stage) {
  return [stage.command, ...stage.args].join(' ')
}

async function writeStageLog(logDir, stageId, payload) {
  const logPath = path.join(logDir, `${stageId}.log`)
  await writeFile(logPath, payload, 'utf8')
  return logPath
}

export async function runStage(stage, context) {
  const startedAt = new Date()
  const started = performance.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const result = await execFileAsync(stage.command, stage.args, {
      cwd: context.appRoot,
      timeout: context.stageTimeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16
    })
    stdout = result.stdout || ''
    stderr = result.stderr || ''
  } catch (error) {
    exitCode = typeof error.code === 'number' ? error.code : 1
    stdout = error.stdout || ''
    stderr = error.stderr || error.message || String(error)
  }

  const durationMs = Math.round(performance.now() - started)
  const redacted = redactValue({ stdout, stderr }, context)
  const logPath = await writeStageLog(
    context.logDir,
    stage.id,
    `${redacted.stdout || ''}${redacted.stderr ? `\n${redacted.stderr}` : ''}`
  )

  return {
    id: stage.id,
    label: stage.label,
    command: redactText(commandLine(stage), context),
    hardGate: stage.hardGate,
    ok: exitCode === 0,
    exitCode,
    startedAt: startedAt.toISOString(),
    durationMs,
    evidence: stage.evidence || '',
    logPath: path.relative(context.appRoot, logPath).replaceAll(path.sep, '/'),
    stdoutSummary: redacted.stdout.split(/\r?\n/).filter(Boolean).slice(-6),
    stderrSummary: redacted.stderr.split(/\r?\n/).filter(Boolean).slice(-6)
  }
}

export async function buildReadinessEvidence({
  appRoot,
  stages,
  startedAt,
  durationMs,
  results,
  warnings = []
}) {
  const metadata = await collectMetadata(appRoot)
  const hardFailures = results.filter((stage) => stage.hardGate && !stage.ok)
  return redactValue(
    {
      schemaVersion: 1,
      ok: hardFailures.length === 0,
      startedAt: startedAt.toISOString(),
      durationMs,
      metadata,
      stages: results,
      plannedStages: stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        hardGate: stage.hardGate,
        command: commandLine(stage)
      })),
      warnings,
      failures: hardFailures.map((stage) => ({
        stage: stage.id,
        label: stage.label,
        exitCode: stage.exitCode,
        logPath: stage.logPath
      }))
    },
    { appRoot }
  )
}

export async function runReadiness(options) {
  const appRoot = path.resolve(options.appRoot)
  const outputDir = path.join(appRoot, '.run', 'release-readiness')
  const logDir = path.join(outputDir, 'logs')
  await mkdir(logDir, { recursive: true })

  const templateMode = options.templateMode ?? (await isTemplateSource(appRoot))
  const stages = options.stages
    ? options.stages.map(normalizeStage)
    : createReadinessPlan({ ...options, templateMode })
  const startedAt = new Date()
  const started = performance.now()
  const context = {
    appRoot,
    logDir,
    stageTimeoutMs: options.stageTimeoutMs || 1000 * 60 * 20
  }
  const results = []
  const warnings = []

  for (const stage of stages) {
    const result = await runStage(stage, context)
    results.push(result)

    if (stage.id === 'performance-check' && result.ok) {
      const performanceEvidence = await readJsonIfExists(
        path.join(appRoot, '.run/performance/latest.json')
      )
      for (const warning of performanceEvidence?.warnings || []) {
        warnings.push({
          stage: stage.id,
          message: `${warning.name} exceeded advisory budget`,
          details: warning
        })
      }
    }

    if (!result.ok && stage.hardGate) break
  }

  const evidence = await buildReadinessEvidence({
    appRoot,
    stages,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    results,
    warnings
  })
  await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
