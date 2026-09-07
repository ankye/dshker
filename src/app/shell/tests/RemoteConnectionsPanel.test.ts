import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi, RemoteConnectionsState } from '@/shared/contracts'
import {
  remoteConnectionEditor,
  resetRemoteConnectionsForTests
} from '@/app/domains/remote-connections'
import RemoteConnectionsPanel from '../components/RemoteConnectionsPanel.vue'

const disconnected: RemoteConnectionsState = {
  connections: [
    {
      connectionId: '11111111-1111-4111-8111-111111111111',
      configRevision: 'a'.repeat(64),
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
    update: vi.fn(async (request) => ({
      ok: true as const,
      data: {
        connections: state.connections.map((entry) =>
          entry.connectionId === request.connectionId
            ? {
                ...entry,
                displayName: request.displayName,
                host: request.host,
                port: request.port,
                user: request.user,
                configRevision: 'b'.repeat(64)
              }
            : entry
        )
      }
    })),
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
  beforeEach(() => {
    resetRemoteConnectionsForTests()
    remoteConnectionEditor.clear()
  })
  afterEach(() => {
    resetRemoteConnectionsForTests()
    remoteConnectionEditor.clear()
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

  it('prefills and submits an explicit edit with the persisted revision, keeping the same row', async () => {
    const { api } = installApi(disconnected)
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()
    await wrapper.get('#remote-edit-11111111-1111-4111-8111-111111111111').trigger('click')
    const form = wrapper.get('[data-testid="remote-edit-form"]')
    const inputs = form.findAll('input')
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('工作室 Mac')
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('10.147.17.251')
    await inputs[0]!.setValue('新版工作室')
    await form.trigger('submit')
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith({
      connectionId: disconnected.connections[0]!.connectionId,
      expectedConfigRevision: 'a'.repeat(64),
      displayName: '新版工作室',
      host: '10.147.17.251',
      port: 22,
      user: 'a1021500932'
    })
    expect(wrapper.find('[data-testid="remote-edit-form"]').exists()).toBe(false)
    expect(wrapper.get('.remote-computer-title').text()).toContain('新版工作室')
    expect(api.remove).not.toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps rejected drafts and requires explicit discard after Escape', async () => {
    const { api } = installApi(disconnected)
    vi.mocked(api.update).mockResolvedValue({
      ok: false,
      code: 'remote.persistence_failed',
      message: 'Unable to save'
    })
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()
    await wrapper.get('#remote-edit-11111111-1111-4111-8111-111111111111').trigger('click')
    const form = wrapper.get('[data-testid="remote-edit-form"]')
    await form.get('input').setValue('未保存输入')
    await form.trigger('submit')
    await flushPromises()
    expect((form.get('input').element as HTMLInputElement).value).toBe('未保存输入')
    expect(wrapper.get('.remote-computer-title').text()).toContain('工作室 Mac')
    await form.trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('有未保存的修改')
    await wrapper.get('[role="alertdialog"] .prototype-button--danger').trigger('click')
    expect(wrapper.find('[data-testid="remote-edit-form"]').exists()).toBe(false)
    expect(api.update).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('reads back an interrupted save without resubmitting it', async () => {
    const { api } = installApi(disconnected)
    const wrapper = mount(RemoteConnectionsPanel)
    await flushPromises()
    vi.mocked(api.update).mockRejectedValue(new Error('reply interrupted'))
    vi.mocked(api.getState).mockResolvedValue({
      ok: true,
      data: {
        connections: disconnected.connections.map((entry) => ({
          ...entry,
          displayName: '已保存',
          configRevision: 'b'.repeat(64)
        }))
      }
    })
    await wrapper.get('#remote-edit-11111111-1111-4111-8111-111111111111').trigger('click')
    const form = wrapper.get('[data-testid="remote-edit-form"]')
    await form.get('input').setValue('已保存')
    await form.trigger('submit')
    await flushPromises()
    expect(api.update).toHaveBeenCalledTimes(1)
    expect(api.getState).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="remote-edit-form"]').exists()).toBe(false)
    expect(wrapper.get('.remote-computer-title').text()).toContain('已保存')
    wrapper.unmount()
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
    await wrapper.get('[data-testid="remote-test-connection"]').trigger('click')
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
