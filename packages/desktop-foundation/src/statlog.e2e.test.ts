// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStatLogQueueStorage, createStatLog } from './statlog'

interface MockStatLogServer {
  endpoint: string
  receivedReports: unknown[]
  close(): Promise<void>
}

let activeServer: MockStatLogServer | undefined

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', reject)
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startMockStatLogServer(): Promise<MockStatLogServer> {
  const receivedReports: unknown[] = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/statlog/capabilities') {
      sendJson(response, 200, { code: 0, platforms: ['desktop'], batch: true })
      return
    }

    if (request.method === 'POST' && request.url === '/v1/statlog/report') {
      const body = JSON.parse(await readRequestBody(request)) as {
        events?: unknown[]
      }
      receivedReports.push(body)
      sendJson(response, 202, {
        code: 0,
        accepted: body.events?.length || 0,
        rejected: 0
      })
      return
    }

    sendJson(response, 404, { code: 404 })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/statlog/report`,
    receivedReports,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

afterEach(async () => {
  await activeServer?.close()
  activeServer = undefined
})

describe('statlog sdk e2e', () => {
  it('reports events and checks capabilities against a local StatLog service', async () => {
    activeServer = await startMockStatLogServer()
    const client = await createStatLog({
      endpoint: activeServer.endpoint,
      projectKey: 'demo',
      appId: 'desktop-app',
      ingestToken: 'token',
      telemetryEnabled: true,
      flushIntervalMs: 0
    })

    client.setUser(1001, { role_id: 'role-1' })
    expect(client.track('desktop_launch', { mode: 'test' })).toBe(true)

    await expect(client.checkCapabilities()).resolves.toMatchObject({
      ok: true,
      data: { platforms: ['desktop'], batch: true }
    })
    await expect(client.flush()).resolves.toMatchObject({
      ok: true,
      accepted: 1
    })

    expect(activeServer.receivedReports).toHaveLength(1)
    expect(activeServer.receivedReports[0]).toMatchObject({
      project_key: 'demo',
      app_id: 'desktop-app',
      events: [
        {
          event_name: 'desktop_launch',
          uid: 1001,
          subject_ids: [{ key: 'role_id', value: 'role-1' }],
          ingest_token: 'token'
        }
      ]
    })

    client.setOptOut(true)
    expect(client.track('suppressed')).toBe(false)
    await client.flush()
    expect(activeServer.receivedReports).toHaveLength(1)
  })

  it('recovers a durable offline queue and flushes when service is available', async () => {
    const storage = createMemoryStatLogQueueStorage()
    const offlineClient = await createStatLog({
      endpoint: 'http://127.0.0.1:9/v1/statlog/report',
      projectKey: 'demo',
      appId: 'desktop-app',
      telemetryEnabled: true,
      flushIntervalMs: 0,
      storage,
      diagnostics: () => undefined
    })

    expect(offlineClient.track('offline_event')).toBe(true)
    await expect(offlineClient.flush()).resolves.toMatchObject({
      ok: false,
      error: { code: 'statlog.transport_failed' }
    })

    activeServer = await startMockStatLogServer()
    const recoveredClient = await createStatLog({
      endpoint: activeServer.endpoint,
      projectKey: 'demo',
      appId: 'desktop-app',
      ingestToken: 'token',
      telemetryEnabled: true,
      flushIntervalMs: 0,
      storage
    })

    expect(recoveredClient.getQueueStatus().queued).toBe(1)
    await expect(recoveredClient.flush()).resolves.toMatchObject({
      ok: true,
      accepted: 1
    })
    expect(activeServer.receivedReports).toHaveLength(1)
  })
})
