import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from './contracts'
import { loadSettings } from './settings'
import { inspectRuntimeConfig, resolveRuntimeConfig } from './config'

function ok<T>(data: T) {
  return { ok: true as const, data }
}

describe('configuration runtime e2e', () => {
  it('loads bridge settings and resolves environment, launch args, flags, and provenance', async () => {
    const api: DesktopApi = {
      app: { getInfo: vi.fn() },
      shell: { getCapabilities: vi.fn(), getCapability: vi.fn() },
      settings: {
        load: vi.fn(async () =>
          ok({
            theme: 'dark' as const,
            locale: 'en-US',
            accentColor: '#445566',
            telemetryEnabled: true,
            autoUpdateChecks: false
          })
        ),
        save: vi.fn(),
        reset: vi.fn()
      },
      storage: { read: vi.fn(), write: vi.fn(), remove: vi.fn() },
      diagnostics: { log: vi.fn() }
    }

    const settings = await loadSettings(api)
    const config = resolveRuntimeConfig({
      persisted: { settings, environment: 'development' },
      environments: {
        staging: {
          values: {
            statlogEndpoint: 'https://staging.example.test/v1/statlog/report'
          },
          featureFlags: { statlog: true }
        }
      },
      argv: ['--env=staging', '--feature=bridgeDiagnostics=true', '--set=timeoutMs=3000'],
      secrets: { statlogIngestToken: 'secret-token' }
    })

    expect(config.environment).toBe('staging')
    expect(config.settings.telemetryEnabled).toBe(true)
    expect(config.featureFlags).toMatchObject({
      bridgeDiagnostics: true,
      statlog: true
    })
    expect(config.values.timeoutMs).toBe(3000)
    expect(inspectRuntimeConfig(config)).toMatchObject({
      values: {
        statlogIngestToken: '[redacted]'
      },
      provenance: {
        environment: 'launch-arg',
        'featureFlags.bridgeDiagnostics': 'launch-arg',
        'featureFlags.statlog': 'environment:staging',
        'values.statlogEndpoint': 'environment:staging',
        'values.timeoutMs': 'launch-arg',
        'values.statlogIngestToken': 'secret'
      }
    })
  })
})
