import { describe, expect, it } from 'vitest'
import {
  inspectRuntimeConfig,
  migrateSettingsRecord,
  parseLaunchArgs,
  resolveRuntimeConfig
} from './config'

describe('configuration runtime', () => {
  it('migrates settings records and normalizes invalid values', () => {
    const migrated = migrateSettingsRecord(
      { schemaVersion: 0, settings: { theme: 'blue' } },
      [
        {
          from: 0,
          to: 1,
          migrate: (record) => ({
            ...record,
            settings: { theme: 'dark', accentColor: '#123456' }
          })
        }
      ],
      1
    )

    expect(migrated.version).toBe(1)
    expect(migrated.record).toMatchObject({
      schemaVersion: 1,
      settings: { theme: 'dark', accentColor: '#123456' }
    })

    const config = resolveRuntimeConfig({
      persisted: { settings: { theme: 'bad' as never, accentColor: 'red' } }
    })
    expect(config.settings.theme).toBe('system')
    expect(config.settings.accentColor).toBe('#2F6FED')
    expect(config.diagnostics.map((event) => event.context?.code)).toContain(
      'config.setting_invalid'
    )
  })

  it('resolves environment with launch args taking precedence over env and settings', () => {
    const config = resolveRuntimeConfig({
      defaults: { environment: 'local' },
      persisted: { environment: 'development' },
      env: { DESKTOP_ENV: 'staging' },
      argv: ['--env=production']
    })

    expect(config.environment).toBe('production')
    expect(config.provenance.environment).toBe('launch-arg')
  })

  it('reports unsupported and malformed launch arguments without throwing', () => {
    const args = parseLaunchArgs([
      '--unknown',
      '--env=bad',
      '--feature=preview=yes',
      '--set',
      'port=3000'
    ])

    expect(args.unsupported).toEqual(['--unknown'])
    expect(args.featureFlags.preview).toBe(true)
    expect(args.values.port).toBe(3000)
    expect(args.diagnostics.map((event) => event.context?.code)).toEqual([
      'config.launch_arg_unsupported',
      'config.environment_invalid'
    ])
  })

  it('resolves feature flags by default, environment, launch arg, and override precedence', () => {
    const config = resolveRuntimeConfig({
      defaults: { featureFlags: { bridgeDiagnostics: false, statlog: false } },
      environments: {
        staging: { featureFlags: { statlog: true } }
      },
      argv: ['--env=staging', '--feature=bridgeDiagnostics=true'],
      overrides: { featureFlags: { statlog: false } }
    })

    expect(config.featureFlags).toEqual({
      bridgeDiagnostics: true,
      statlog: false
    })
    expect(config.provenance['featureFlags.bridgeDiagnostics']).toBe('launch-arg')
    expect(config.provenance['featureFlags.statlog']).toBe('override')
  })

  it('exposes sanitized debug inspection and provenance', () => {
    const config = resolveRuntimeConfig({
      defaults: { values: { endpoint: 'https://api.example.test' } },
      secrets: { ingestToken: 'super-secret-token' },
      argv: ['--set=timeoutMs=5000']
    })
    const debug = inspectRuntimeConfig(config)

    expect(debug).toMatchObject({
      environment: 'development',
      values: {
        endpoint: 'https://api.example.test',
        ingestToken: '[redacted]',
        timeoutMs: 5000
      },
      provenance: {
        'values.endpoint': 'default',
        'values.ingestToken': 'secret',
        'values.timeoutMs': 'launch-arg'
      }
    })
  })
})
