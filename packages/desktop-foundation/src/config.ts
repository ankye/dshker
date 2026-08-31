import type { AppSettings, DiagnosticEvent } from './contracts'
import { redactSecrets } from './logger'
import { DEFAULT_SETTINGS } from './contracts'
import { normalizeSettings } from './settings'

export const RUNTIME_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number]

export interface SettingsMigration {
  from: number
  to: number
  migrate(record: Record<string, unknown>): Record<string, unknown>
}

export interface SettingsMigrationResult {
  record: Record<string, unknown>
  version: number
  diagnostics: DiagnosticEvent[]
}

export interface ParsedLaunchArgs {
  environment?: RuntimeEnvironment
  featureFlags: Record<string, boolean>
  values: Record<string, string | number | boolean>
  unsupported: string[]
  diagnostics: DiagnosticEvent[]
}

export interface RuntimeConfigLayer {
  environment?: string
  settings?: Partial<AppSettings>
  featureFlags?: Record<string, unknown>
  values?: Record<string, unknown>
}

export interface RuntimeConfigInput {
  defaults?: RuntimeConfigLayer
  persisted?: RuntimeConfigLayer & { schemaVersion?: number }
  environments?: Record<string, RuntimeConfigLayer>
  env?: Record<string, string | undefined>
  argv?: readonly string[]
  launchArgs?: ParsedLaunchArgs
  secrets?: Record<string, unknown>
  overrides?: RuntimeConfigLayer
  migrations?: readonly SettingsMigration[]
  targetSettingsVersion?: number
}

export interface RuntimeConfig {
  environment: RuntimeEnvironment
  settings: AppSettings
  featureFlags: Record<string, boolean>
  values: Record<string, unknown>
  launchArgs: ParsedLaunchArgs
  provenance: Record<string, string>
  diagnostics: DiagnosticEvent[]
}

const DEFAULT_ENVIRONMENT: RuntimeEnvironment = 'development'
const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['0', 'false', 'no', 'off'])

function diagnostic(
  code: string,
  message: string,
  context?: Record<string, unknown>
): DiagnosticEvent {
  return { level: 'warn', message, context: { code, ...(context || {}) } }
}

export function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return typeof value === 'string' && RUNTIME_ENVIRONMENTS.includes(value as RuntimeEnvironment)
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (BOOLEAN_TRUE.has(normalized)) return true
    if (BOOLEAN_FALSE.has(normalized)) return false
  }
  return undefined
}

function readLaunchValue(value: string): string | number | boolean {
  const booleanValue = readBoolean(value)
  if (booleanValue !== undefined) return booleanValue
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

function parseAssignment(raw: string): [string, string] | undefined {
  const index = raw.indexOf('=')
  if (index <= 0) return undefined
  return [raw.slice(0, index), raw.slice(index + 1)]
}

function takeNext(
  argv: readonly string[],
  index: number,
  flag: string,
  diagnostics: DiagnosticEvent[]
) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    diagnostics.push(
      diagnostic('config.launch_arg_missing_value', `Missing value for launch argument ${flag}.`, {
        flag
      })
    )
    return undefined
  }
  return value
}

function applyLaunchEnvironment(
  value: string,
  output: ParsedLaunchArgs,
  diagnostics: DiagnosticEvent[]
): void {
  if (isRuntimeEnvironment(value)) {
    output.environment = value
    return
  }
  diagnostics.push(
    diagnostic('config.environment_invalid', 'Unsupported runtime environment.', { value })
  )
}

function applyFeatureFlag(
  raw: string,
  output: ParsedLaunchArgs,
  diagnostics: DiagnosticEvent[]
): void {
  const assignment = parseAssignment(raw)
  const value = assignment ? readBoolean(assignment[1]) : undefined
  if (!assignment || value === undefined) {
    diagnostics.push(
      diagnostic(
        'config.feature_flag_invalid',
        'Feature flag launch argument must be name=true/false.',
        {
          value: raw
        }
      )
    )
    return
  }
  output.featureFlags[assignment[0]] = value
}

function applyLaunchValue(
  raw: string,
  output: ParsedLaunchArgs,
  diagnostics: DiagnosticEvent[]
): void {
  const assignment = parseAssignment(raw)
  if (!assignment) {
    diagnostics.push(
      diagnostic('config.launch_arg_invalid', 'Launch setting must be name=value.', { value: raw })
    )
    return
  }
  output.values[assignment[0]] = readLaunchValue(assignment[1])
}

export function parseLaunchArgs(argv: readonly string[] = []): ParsedLaunchArgs {
  const diagnostics: DiagnosticEvent[] = []
  const output: ParsedLaunchArgs = {
    featureFlags: {},
    values: {},
    unsupported: [],
    diagnostics
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--env' || arg === '--environment') {
      const value = takeNext(argv, index, arg, diagnostics)
      if (value) {
        applyLaunchEnvironment(value, output, diagnostics)
        index += 1
      }
    } else if (arg.startsWith('--env=')) {
      applyLaunchEnvironment(arg.slice('--env='.length), output, diagnostics)
    } else if (arg.startsWith('--environment=')) {
      applyLaunchEnvironment(arg.slice('--environment='.length), output, diagnostics)
    } else if (arg === '--feature') {
      const value = takeNext(argv, index, arg, diagnostics)
      if (value) {
        applyFeatureFlag(value, output, diagnostics)
        index += 1
      }
    } else if (arg.startsWith('--feature=')) {
      applyFeatureFlag(arg.slice('--feature='.length), output, diagnostics)
    } else if (arg === '--set') {
      const value = takeNext(argv, index, arg, diagnostics)
      if (value) {
        applyLaunchValue(value, output, diagnostics)
        index += 1
      }
    } else if (arg.startsWith('--set=')) {
      applyLaunchValue(arg.slice('--set='.length), output, diagnostics)
    } else {
      output.unsupported.push(arg)
      diagnostics.push(
        diagnostic('config.launch_arg_unsupported', 'Unsupported launch argument ignored.', { arg })
      )
    }
  }

  return output
}

export function migrateSettingsRecord(
  input: Record<string, unknown> | undefined,
  migrations: readonly SettingsMigration[] = [],
  targetVersion = 1
): SettingsMigrationResult {
  let record = { ...(input || {}) }
  let version =
    typeof record.schemaVersion === 'number' && Number.isInteger(record.schemaVersion)
      ? record.schemaVersion
      : 0
  const diagnostics: DiagnosticEvent[] = []

  for (const migration of [...migrations].sort((a, b) => a.from - b.from)) {
    if (version !== migration.from) continue
    record = migration.migrate(record)
    version = migration.to
    record.schemaVersion = version
  }

  if (version !== targetVersion) {
    diagnostics.push(
      diagnostic('config.settings_version_mismatch', 'Settings schema version was normalized.', {
        from: version,
        to: targetVersion
      })
    )
    version = targetVersion
    record.schemaVersion = targetVersion
  }

  return { record, version, diagnostics }
}

function environmentFromLayer(
  value: unknown,
  fallback: RuntimeEnvironment,
  source: string,
  diagnostics: DiagnosticEvent[]
): RuntimeEnvironment {
  if (value === undefined || value === '') return fallback
  if (isRuntimeEnvironment(value)) return value
  diagnostics.push(
    diagnostic('config.environment_invalid', 'Unsupported runtime environment.', { source, value })
  )
  return fallback
}

function environmentFromEnv(env: RuntimeConfigInput['env']): string | undefined {
  return env?.DESKTOP_ENV || env?.APP_ENV || env?.NODE_ENV
}

function applySettingLayer(
  settings: AppSettings,
  provenance: Record<string, string>,
  source: string,
  layer: Partial<AppSettings> | undefined,
  diagnostics: DiagnosticEvent[]
): AppSettings {
  if (!layer) return settings
  const next = normalizeSettings({ ...settings, ...layer })

  for (const key of Object.keys(layer) as (keyof AppSettings)[]) {
    if (next[key] !== layer[key]) {
      diagnostics.push(
        diagnostic('config.setting_invalid', 'Invalid setting value was normalized.', {
          source,
          key
        })
      )
    }
    provenance[`settings.${key}`] = source
  }

  return next
}

function applyFeatureLayer(
  flags: Record<string, boolean>,
  provenance: Record<string, string>,
  source: string,
  layer: Record<string, unknown> | undefined,
  diagnostics: DiagnosticEvent[]
): void {
  if (!layer) return
  for (const [key, rawValue] of Object.entries(layer)) {
    const value = readBoolean(rawValue)
    if (value === undefined) {
      diagnostics.push(
        diagnostic('config.feature_flag_invalid', 'Invalid feature flag value was ignored.', {
          source,
          key
        })
      )
      continue
    }
    flags[key] = value
    provenance[`featureFlags.${key}`] = source
  }
}

function applyValueLayer(
  values: Record<string, unknown>,
  provenance: Record<string, string>,
  source: string,
  layer: Record<string, unknown> | undefined
): void {
  if (!layer) return
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    values[key] = value
    provenance[`values.${key}`] = source
  }
}

export function resolveRuntimeConfig(input: RuntimeConfigInput = {}): RuntimeConfig {
  const launchArgs = input.launchArgs || parseLaunchArgs(input.argv)
  const diagnostics = [...launchArgs.diagnostics]
  const provenance: Record<string, string> = {}
  const migrated = migrateSettingsRecord(
    input.persisted as Record<string, unknown> | undefined,
    input.migrations,
    input.targetSettingsVersion
  )
  const persistedLayer = { ...(input.persisted || {}), ...migrated.record } as RuntimeConfigLayer
  diagnostics.push(...migrated.diagnostics)

  let environment = environmentFromLayer(
    input.defaults?.environment || DEFAULT_ENVIRONMENT,
    DEFAULT_ENVIRONMENT,
    'default',
    diagnostics
  )
  provenance.environment = input.defaults?.environment ? 'default' : 'default:builtin'
  environment = environmentFromLayer(
    persistedLayer.environment,
    environment,
    'setting',
    diagnostics
  )
  if (persistedLayer.environment) provenance.environment = 'setting'
  environment = environmentFromLayer(
    environmentFromEnv(input.env),
    environment,
    'environment',
    diagnostics
  )
  if (environmentFromEnv(input.env)) provenance.environment = 'environment'
  environment = environmentFromLayer(launchArgs.environment, environment, 'launch-arg', diagnostics)
  if (launchArgs.environment) provenance.environment = 'launch-arg'
  environment = environmentFromLayer(
    input.overrides?.environment,
    environment,
    'override',
    diagnostics
  )
  if (input.overrides?.environment) provenance.environment = 'override'

  const environmentLayer = input.environments?.[environment]
  let settings = applySettingLayer(
    normalizeSettings({ ...DEFAULT_SETTINGS, ...(input.defaults?.settings || {}) }),
    provenance,
    'default',
    { ...DEFAULT_SETTINGS, ...(input.defaults?.settings || {}) },
    diagnostics
  )
  settings = applySettingLayer(
    settings,
    provenance,
    'setting',
    persistedLayer.settings,
    diagnostics
  )
  settings = applySettingLayer(
    settings,
    provenance,
    `environment:${environment}`,
    environmentLayer?.settings,
    diagnostics
  )
  settings = applySettingLayer(
    settings,
    provenance,
    'override',
    input.overrides?.settings,
    diagnostics
  )

  const featureFlags: Record<string, boolean> = {}
  applyFeatureLayer(featureFlags, provenance, 'default', input.defaults?.featureFlags, diagnostics)
  applyFeatureLayer(featureFlags, provenance, 'setting', persistedLayer.featureFlags, diagnostics)
  applyFeatureLayer(
    featureFlags,
    provenance,
    `environment:${environment}`,
    environmentLayer?.featureFlags,
    diagnostics
  )
  applyFeatureLayer(featureFlags, provenance, 'launch-arg', launchArgs.featureFlags, diagnostics)
  applyFeatureLayer(
    featureFlags,
    provenance,
    'override',
    input.overrides?.featureFlags,
    diagnostics
  )

  const values: Record<string, unknown> = {}
  applyValueLayer(values, provenance, 'default', input.defaults?.values)
  applyValueLayer(values, provenance, `environment:${environment}`, environmentLayer?.values)
  applyValueLayer(values, provenance, 'launch-arg', launchArgs.values)
  applyValueLayer(values, provenance, 'secret', input.secrets)
  applyValueLayer(values, provenance, 'override', input.overrides?.values)

  return {
    environment,
    settings,
    featureFlags,
    values,
    launchArgs,
    provenance,
    diagnostics
  }
}

export function inspectRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    settings: config.settings,
    featureFlags: config.featureFlags,
    values: redactSecrets(config.values),
    launchArgs: {
      environment: config.launchArgs.environment,
      featureFlags: config.launchArgs.featureFlags,
      values: redactSecrets(config.launchArgs.values),
      unsupported: config.launchArgs.unsupported
    },
    provenance: config.provenance,
    diagnostics: redactSecrets(config.diagnostics)
  }
}
