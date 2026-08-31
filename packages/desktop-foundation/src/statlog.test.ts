import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi, DiagnosticEvent } from './contracts'
import {
  StatLogClient,
  createBridgeStatLogTransport,
  createMemoryStatLogQueueStorage,
  objectToStatLogKV,
  resolveStatLogConfig,
  resolveStatLogCapabilitiesEndpoint,
  type StatLogTransport
} from './statlog'

function createClient(
  transport: StatLogTransport,
  diagnostics: DiagnosticEvent[] = [],
  storage = createMemoryStatLogQueueStorage()
): StatLogClient {
  return new StatLogClient({
    endpoint: 'https://example.test/v1/statlog/report',
    projectId: 7,
    projectKey: 'demo',
    appId: 'desktop-app',
    ingestToken: 'ingest-secret',
    platform: 'win32',
    reporter: 'desktop',
    telemetryEnabled: true,
    flushIntervalMs: 0,
    transport,
    storage,
    clock: () => 1780737600000,
    idGenerator: (prefix) => `${prefix}_fixed`,
    diagnostics: (event) => {
      diagnostics.push(event)
    }
  })
}

describe('statlog sdk', () => {
  it('serializes properties to safe StatLog KV entries', () => {
    expect(
      objectToStatLogKV({
        role_id: 'role-1',
        level: 3,
        active: true,
        skipped: undefined
      })
    ).toEqual([
      { key: 'role_id', value: 'role-1' },
      { key: 'level', value: '3' },
      { key: 'active', value: 'true' }
    ])

    expect(() => objectToStatLogKV({ '../bad': 'x' })).toThrow('Unsafe StatLog key')
  })

  it('builds a protocol-compatible batch and event envelope', async () => {
    let sentBody: unknown
    const transport = vi.fn(async (request) => {
      sentBody = request.body
      return {
        ok: true,
        status: 202,
        body: { code: 0, accepted: 1, rejected: 0 }
      }
    })
    const client = createClient(transport)
    await client.setup()

    client.setUser(1001, { role_id: 'role-1' })
    client.setContext({ env: 'test' })

    expect(client.track('login', { channel: 'desktop' }, { scene: 'home' })).toBe(true)
    await expect(client.flush()).resolves.toMatchObject({
      ok: true,
      accepted: 1,
      rejected: 0
    })

    expect(sentBody).toMatchObject({
      batch_id: 'batch_fixed',
      project_id: 7,
      project_key: 'demo',
      app_id: 'desktop-app',
      source: 'desktop',
      events: [
        {
          event_id: 'evt_fixed',
          project_id: 7,
          project_key: 'demo',
          app_id: 'desktop-app',
          platform: 'win32',
          sdk_name: 'statlog-desktop',
          sdk_version: '0.1.0',
          event_name: 'login',
          event_time_ms: 1780737600000,
          uid: 1001,
          device_id: 'device_fixed',
          session_id: 'session_fixed',
          scene: 'home',
          subject_ids: [{ key: 'role_id', value: 'role-1' }],
          properties: [{ key: 'channel', value: 'desktop' }],
          context: [{ key: 'env', value: 'test' }],
          reporter: 'desktop',
          ingest_token: 'ingest-secret'
        }
      ]
    })
  })

  it('requires telemetry consent and clears the queue on opt out', async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: { accepted: 1 }
    }))
    const client = new StatLogClient({
      endpoint: 'https://example.test/v1/statlog/report',
      appId: 'desktop-app',
      flushIntervalMs: 0,
      transport
    })
    await client.setup()

    expect(client.track('login')).toBe(false)
    client.setTelemetryEnabled(true)
    expect(client.track('login')).toBe(true)
    expect(client.getQueueStatus().queued).toBe(1)

    client.setOptOut(true)
    expect(client.getQueueStatus().queued).toBe(0)
    expect(client.track('pay')).toBe(false)
    await client.flush()
    expect(transport).not.toHaveBeenCalled()
  })

  it('persists a bounded queue and recovers it on setup', async () => {
    const storage = createMemoryStatLogQueueStorage()
    const transport = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: { accepted: 1 }
    }))
    const firstClient = new StatLogClient({
      endpoint: 'https://example.test/v1/statlog/report',
      appId: 'desktop-app',
      telemetryEnabled: true,
      queueLimit: 2,
      flushIntervalMs: 0,
      transport,
      storage,
      idGenerator: (prefix) => `${prefix}_${Math.random()}`
    })
    await firstClient.setup()

    expect(firstClient.track('event_one')).toBe(true)
    expect(firstClient.track('event_two')).toBe(true)
    expect(firstClient.track('event_three')).toBe(true)
    expect(firstClient.getQueueStatus()).toMatchObject({
      queued: 2,
      dropped: 1
    })

    const secondClient = new StatLogClient({
      endpoint: 'https://example.test/v1/statlog/report',
      appId: 'desktop-app',
      telemetryEnabled: true,
      flushIntervalMs: 0,
      transport,
      storage
    })
    await secondClient.setup()

    expect(secondClient.getQueueStatus().queued).toBe(2)
  })

  it('keeps queued events and schedules retry on backpressure', async () => {
    const diagnostics: DiagnosticEvent[] = []
    const transport = vi.fn(async () => ({
      ok: false,
      status: 429,
      body: { code: 429 }
    }))
    const client = createClient(transport, diagnostics)
    await client.setup()
    client.track('launch')

    const result = await client.flush()

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      error: { code: 'statlog.backpressure' }
    })
    expect(client.getQueueStatus()).toMatchObject({
      queued: 1,
      pendingRetry: true,
      lastErrorCode: 'statlog.backpressure'
    })
    expect(diagnostics[0]).toMatchObject({ level: 'warn' })
  })

  it('checks capabilities without mutating the event queue', async () => {
    const transport = vi.fn(async (request) => {
      expect(request.method).toBe('GET')
      return {
        ok: true,
        status: 200,
        body: {
          code: 0,
          platforms: ['js', 'flutter', 'cocos', 'backend'],
          batch: true
        }
      }
    })
    const client = createClient(transport)
    await client.setup()
    client.track('launch')

    await expect(client.checkCapabilities()).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        code: 0,
        platforms: ['js', 'flutter', 'cocos', 'backend'],
        batch: true
      }
    })
    expect(client.getQueueStatus().queued).toBe(1)
  })

  it('resolves environment, settings, launch args, secrets, and overrides', () => {
    const resolved = resolveStatLogConfig({
      environment: 'staging',
      appId: 'desktop-app',
      defaults: {
        endpoint: 'https://default.test/v1/statlog/report',
        projectKey: 'default',
        telemetryEnabled: false
      },
      environments: {
        staging: {
          endpoint: 'https://staging.test/v1/statlog/report',
          projectKey: 'staging'
        }
      },
      settings: {
        telemetryEnabled: true
      },
      launchArgs: {
        statlogProjectId: '9',
        statlogBatchSize: '3'
      },
      secrets: {
        ingestToken: 'secret-token'
      },
      overrides: {
        reporter: 'desktop-test'
      }
    })

    expect(resolved.options).toMatchObject({
      endpoint: 'https://staging.test/v1/statlog/report',
      projectId: 9,
      projectKey: 'staging',
      appId: 'desktop-app',
      ingestToken: 'secret-token',
      batchSize: 3,
      telemetryEnabled: true,
      reporter: 'desktop-test'
    })
    expect(resolved.provenance).toMatchObject({
      endpoint: 'environment:staging',
      projectId: 'launch-arg',
      batchSize: 'launch-arg',
      ingestToken: 'secret',
      reporter: 'override'
    })
  })

  it('routes StatLog transport through an optional bridge API', async () => {
    const api = {
      app: { getInfo: vi.fn() },
      shell: { getCapabilities: vi.fn(), getCapability: vi.fn() },
      settings: { load: vi.fn(), save: vi.fn(), reset: vi.fn() },
      storage: { read: vi.fn(), write: vi.fn(), remove: vi.fn() },
      diagnostics: { log: vi.fn() },
      statlog: {
        request: vi.fn(async () => ({
          ok: true as const,
          data: { ok: true, status: 202, body: { accepted: 1, rejected: 0 } }
        }))
      }
    } satisfies DesktopApi

    const transport = createBridgeStatLogTransport(api)

    await expect(
      transport({
        method: 'POST',
        url: 'https://example.test/v1/statlog/report',
        headers: { 'content-type': 'application/json' },
        body: { events: [] },
        timeoutMs: 1000
      })
    ).resolves.toEqual({
      ok: true,
      status: 202,
      body: { accepted: 1, rejected: 0 }
    })
    expect(api.statlog.request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://example.test/v1/statlog/report',
      headers: { 'content-type': 'application/json' },
      body: { events: [] },
      timeoutMs: 1000
    })
  })

  it('derives the capabilities endpoint from the report endpoint', () => {
    expect(resolveStatLogCapabilitiesEndpoint('https://api.test/v1/statlog/report')).toBe(
      'https://api.test/v1/statlog/capabilities'
    )
  })

  it('redacts secret-like diagnostic details', async () => {
    const diagnostics: DiagnosticEvent[] = []
    const secret = 'a'.repeat(80)
    const transport = vi.fn(async () => {
      throw new Error(`transport failed ${secret}`)
    })
    const client = createClient(transport, diagnostics)
    await client.setup()
    client.track('launch')

    await client.flush()

    expect(diagnostics[0]?.context?.details).toBe('[redacted]')
  })
})
