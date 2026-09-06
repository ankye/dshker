import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import { remoteConnectionsState } from '@/app/domains/remote-connections'
import type { LauncherHarnessState } from '@/shared/contracts'
import { isLoopbackAddress, runtimeBrowser } from './runtimeBrowserState'

const LOCAL_URL = 'http://127.0.0.1:3088/?token=local'
const REMOTE_URL = 'http://127.0.0.1:41001/?token=remote'

function localState(url?: string): LauncherHarnessState {
  return {
    kind: 'ready',
    harnessDirectory: '/managed/harness',
    remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    currentBranch: 'master',
    branches: ['master'],
    revision: '0123456789abcdef',
    launch: url === undefined ? { kind: 'stopped' } : { kind: 'running', url },
    port: { mode: 'auto' },
    commits: [],
    stableVersions: [],
    plugins: [],
    console: [],
    logFile: { path: '/managed/logs/dsh-web.log', exists: true, byteLength: 1 }
  }
}

describe('isLoopbackAddress', () => {
  it('admits DSH loopback addresses and rejects other authority', () => {
    expect(isLoopbackAddress('http://127.0.0.1:3088/?token=abc')).toBe(true)
    expect(isLoopbackAddress('http://localhost:3088/')).toBe(true)
    expect(isLoopbackAddress('http://10.0.0.9:3088/')).toBe(false)
    expect(isLoopbackAddress('file:///etc/passwd')).toBe(false)
    expect(isLoopbackAddress('not a url')).toBe(false)
  })
})

describe('fixed runtime workspaces', () => {
  beforeEach(async () => {
    harnessState.value = undefined
    remoteConnectionsState.value = { connections: [] }
    runtimeBrowser.activeTabId.value = 'local'
    await nextTick()
  })

  it('always retains one local tab through stop and start', async () => {
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual(['local'])
    expect(runtimeBrowser.tabs.value[0]?.url).toBeUndefined()

    harnessState.value = localState(LOCAL_URL)
    await nextTick()
    expect(runtimeBrowser.tabs.value[0]?.url).toBe(LOCAL_URL)

    harnessState.value = localState()
    await nextTick()
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual(['local'])
    expect(runtimeBrowser.tabs.value[0]?.url).toBeUndefined()
  })

  it('projects one non-disposable tab per registered computer', async () => {
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          displayName: 'Studio Mac',
          host: 'studio-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'disconnected' },
          testStatus: { kind: 'untested' }
        },
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          displayName: 'Office PC',
          host: 'office-pc',
          port: 2222,
          user: 'dev',
          status: { kind: 'ready', url: REMOTE_URL },
          testStatus: { kind: 'passed' }
        }
      ]
    }
    await nextTick()
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual([
      'local',
      'remote:11111111-1111-4111-8111-111111111111',
      'remote:22222222-2222-4222-8222-222222222222'
    ])
    expect(runtimeBrowser.tabs.value[1]?.url).toBeUndefined()
    expect(runtimeBrowser.tabs.value[2]?.url).toBe(REMOTE_URL)
  })

  it('clears a remote URL on disconnect while retaining its tab', async () => {
    const connectionId = '33333333-3333-4333-8333-333333333333'
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId,
          displayName: 'Build Mac',
          host: 'build-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'ready', url: REMOTE_URL },
          testStatus: { kind: 'passed' }
        }
      ]
    }
    await nextTick()
    runtimeBrowser.updateTab(`remote:${connectionId}`, {
      url: `${REMOTE_URL}session/1`,
      title: 'Session'
    })
    expect(runtimeBrowser.tabs.value[1]?.title).toBe('Session')
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId,
          displayName: 'Build Mac',
          host: 'build-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'ready', url: REMOTE_URL },
          testStatus: { kind: 'passed' }
        }
      ]
    }
    await nextTick()
    expect(runtimeBrowser.tabs.value[1]?.url).toBe(`${REMOTE_URL}session/1`)

    remoteConnectionsState.value = {
      connections: [
        {
          connectionId,
          displayName: 'Build Mac',
          host: 'build-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'disconnected' },
          testStatus: { kind: 'passed' }
        }
      ]
    }
    await nextTick()
    expect(runtimeBrowser.tabs.value[1]?.url).toBeUndefined()
    expect(runtimeBrowser.tabs.value[1]?.title).toBe('Build Mac')
  })

  it('returns focus to local only when the selected computer is removed', async () => {
    const connectionId = '44444444-4444-4444-8444-444444444444'
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId,
          displayName: 'Laptop',
          host: 'laptop',
          port: 22,
          user: 'dev',
          status: { kind: 'disconnected' },
          testStatus: { kind: 'untested' }
        }
      ]
    }
    await nextTick()
    runtimeBrowser.activeTabId.value = `remote:${connectionId}`
    remoteConnectionsState.value = { connections: [] }
    await nextTick()
    expect(runtimeBrowser.activeTabId.value).toBe('local')
  })
})
