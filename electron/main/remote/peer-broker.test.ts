import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LauncherHarnessState } from '../../../src/shared/contracts'
import { RemotePeerBroker, parseRemotePeerDescriptor } from './peer-broker'

const RUNTIME_URL = 'http://127.0.0.1:3080/?token=remote-secret'
let root: string
let broker: RemotePeerBroker | undefined

function state(kind: 'stopped' | 'running'): LauncherHarnessState {
  return {
    kind: 'ready',
    harnessDirectory: '/managed/harness',
    remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    currentBranch: 'master',
    branches: ['master'],
    revision: '0123456789abcdef',
    launch: kind === 'running' ? { kind, url: RUNTIME_URL } : { kind },
    port: { mode: 'auto' },
    commits: [],
    stableVersions: [],
    plugins: [],
    console: [],
    logFile: { path: '/managed/logs/dsh-web.log', exists: true, byteLength: 1 }
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dshker-peer-broker-'))
})

afterEach(async () => {
  await broker?.shutdown()
  broker = undefined
  await rm(root, { recursive: true, force: true })
})

describe('RemotePeerBroker', () => {
  it('writes an authenticated descriptor and returns an already-running exact URL', async () => {
    const getState = vi.fn(async () => state('running'))
    broker = new RemotePeerBroker({
      descriptorPath: path.join(root, 'remote-peer.json'),
      launcherHarnessService: { getState, start: vi.fn() }
    })
    const descriptor = await broker.start()
    expect(
      parseRemotePeerDescriptor(await readFile(path.join(root, 'remote-peer.json'), 'utf8'))
    ).toEqual(descriptor)

    expect(await post(descriptor.port, descriptor.secret)).toEqual({
      status: 200,
      body: { version: 1, url: RUNTIME_URL }
    })
    expect(await post(descriptor.port, 'wrong-secret')).toMatchObject({ status: 401 })
  })

  it('starts the Launcher-owned runtime when stopped', async () => {
    const start = vi.fn(async () => state('running'))
    broker = new RemotePeerBroker({
      descriptorPath: path.join(root, 'remote-peer.json'),
      launcherHarnessService: { getState: vi.fn(async () => state('stopped')), start }
    })
    const descriptor = await broker.start()
    expect(await post(descriptor.port, descriptor.secret)).toMatchObject({ status: 200 })
    expect(start).toHaveBeenCalledOnce()
  })

  it('rejects unknown descriptor fields and rotates secrets across starts', async () => {
    expect(() =>
      parseRemotePeerDescriptor(
        JSON.stringify({
          format: 'dsh-launcher.remote-peer',
          version: 1,
          instanceId: '11111111-1111-4111-8111-111111111111',
          port: 3000,
          secret: 'a'.repeat(43),
          extra: true
        })
      )
    ).toThrowError(/fields/u)
    broker = new RemotePeerBroker({
      descriptorPath: path.join(root, 'remote-peer.json'),
      launcherHarnessService: { getState: vi.fn(async () => state('running')), start: vi.fn() }
    })
    const first = await broker.start()
    await broker.shutdown()
    const second = await broker.start()
    expect(second.secret).not.toBe(first.secret)
  })
})

async function post(port: number, secret: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/runtime/connect',
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-length': '0' }
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) })
        )
      }
    )
    operation.once('error', reject)
    operation.end()
  })
}
