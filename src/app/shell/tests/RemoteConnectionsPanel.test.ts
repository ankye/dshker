import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi, RemoteConnectionsState } from '@/shared/contracts'
import { resetRemoteConnectionsForTests } from '@/app/domains/remote-connections'
import RemoteConnectionsPanel from '../components/RemoteConnectionsPanel.vue'

const disconnected: RemoteConnectionsState = {
  connections: [
    {
      connectionId: '11111111-1111-4111-8111-111111111111',
      displayName: '工作室 Mac',
      host: '10.147.17.251',
      port: 22,
      user: 'a1021500932',
      status: { kind: 'disconnected' },
      testStatus: { kind: 'untested' }
    }
  ]
}

function installApi(state: RemoteConnectionsState = { connections: [] }) {
  let listener: Parameters<DesktopApi['remoteConnections']['onStateChange']>[0] | undefined
  const api: DesktopApi['remoteConnections'] = {
    getState: vi.fn(async () => ({ ok: true as const, data: state })),
    create: vi.fn(async () => ({ ok: true as const, data: disconnected })),
    test: vi.fn(async () => ({
      ok: true as const,
      data: {
        connections: disconnected.connections.map((connection) => ({
          ...connection,
          testStatus: { kind: 'passed' as const }
        }))
      }
    })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: {
        connections: disconnected.connections.map((connection) => ({
          ...connection,
          status: { kind: 'ready' as const, url: 'http://127.0.0.1:41000/?token=abc' }
        }))
      }
    })),
    disconnect: vi.fn(async () => ({ ok: true as const, data: disconnected })),
    remove: vi.fn(async () => ({ ok: true as const, data: { connections: [] } })),
    onStateChange: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    }
  }
  window.dshLauncher = { remoteConnections: api } as DesktopApi
  return { api, publish: (next: RemoteConnectionsState) => listener?.({ ok: true, data: next }) }
}

describe('RemoteConnectionsPanel', () => {
  beforeEach(() => resetRemoteConnectionsForTests())
  afterEach(() => {
    resetRemoteConnectionsForTests()
    window.dshLauncher = undefined
  })

  it('submits all explicit fields and renders the resulting durable row', async () => {
    const { api } = installApi()
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('工作室 Mac')
    await inputs[1]!.setValue('10.147.17.251')
    await inputs[2]!.setValue('22')
    await inputs[3]!.setValue('a1021500932')
    await wrapper.get('[data-testid="remote-add-form"]').trigger('submit')
    await flushPromises()
    expect(api.create).toHaveBeenCalledWith({
      displayName: '工作室 Mac',
      host: '10.147.17.251',
      port: 22,
      user: 'a1021500932'
    })
    expect(wrapper.text()).toContain('工作室 Mac')
    expect(wrapper.text()).toContain('a1021500932@10.147.17.251:22')
  })

  it('shows distinct disconnected, connecting, ready, and failed states from peer events', async () => {
    const { publish } = installApi(disconnected)
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('未连接')
    const base = disconnected.connections[0]!
    publish({ connections: [{ ...base, status: { kind: 'connecting' } }] })
    await flushPromises()
    expect(wrapper.text()).toContain('连接中')
    publish({
      connections: [{ ...base, status: { kind: 'ready', url: 'http://127.0.0.1:41000/' } }]
    })
    await flushPromises()
    expect(wrapper.text()).toContain('已连接')
    publish({
      connections: [
        {
          ...base,
          status: {
            kind: 'failed',
            code: 'remote.ssh_authentication_failed',
            message: 'hidden diagnostic'
          }
        }
      ]
    })
    await flushPromises()
    expect(wrapper.text()).toContain('SSH 认证或主机密钥校验失败')
    expect(wrapper.text()).not.toContain('hidden diagnostic')
  })

  it('runs a full connection test and renders red/green semantic state', async () => {
    const { api } = installApi(disconnected)
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()

    const disconnectedBadge = wrapper.get('.remote-status')
    expect(disconnectedBadge.attributes('data-state')).toBe('disconnected')
    expect(disconnectedBadge.text()).toContain('未连接')
    await wrapper.get('.remote-row-actions button').trigger('click')
    await flushPromises()

    expect(api.test).toHaveBeenCalledWith({
      connectionId: '11111111-1111-4111-8111-111111111111'
    })
    const testBadge = wrapper.get('.remote-test-status')
    expect(testBadge.attributes('data-state')).toBe('passed')
    expect(testBadge.text()).toContain('测试通过')
    expect(wrapper.get('.remote-status').attributes('data-state')).toBe('disconnected')
  })
})
