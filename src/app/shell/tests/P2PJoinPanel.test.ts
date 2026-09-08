import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PCatalogView, P2PManagementApi, P2PRegistrationView } from '@/shared/p2p-management'

const serviceId = 'a'.repeat(64)
const service = {
  serviceId,
  publicKey: 'pinned-key',
  displayName: 'Home server',
  httpsOrigin: 'https://peer.example',
  wssUrl: 'wss://peer.example/v1/signals',
  stunAddress: 'peer.example:3478'
}
const saved: P2PCatalogView = {
  revision: 'r1',
  catalogId: 'catalog',
  services: [service],
  computers: [],
  forgottenServiceIds: []
}
const registered: P2PRegistrationView = {
  kind: 'registered',
  serviceId,
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'b'.repeat(64),
  deviceId: 'device-a'
}
let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined

beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  window.dshLauncher = previous
})

async function render(api: Partial<P2PManagementApi>) {
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const domain = await import('@/app/domains/remote-connections')
  domain.p2pManagement.catalog.value = saved
  domain.p2pManagement.selectedServiceId.value = serviceId
  const component = (await import('../components/P2PJoinPanel.vue')).default
  wrapper = mount(component)
  await flushPromises()
  return wrapper
}

async function fillJoinForm(ui: VueWrapper, networkId: string, name: string) {
  await ui.get('[data-testid="p2p-join-network"]').setValue(networkId)
  await ui.get('[data-testid="p2p-join-name"]').setValue(name)
}

describe('P2P login-free join panel', () => {
  it('shows a pending/loading state and then a registered-not-meshed success card', async () => {
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['joinNetwork']>>) => void
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const ui = await render({ joinNetwork })
    await fillJoinForm(ui, 'network-b', 'My computer')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    expect(ui.get('[data-testid="p2p-join-loading"]').text()).not.toBe('')
    expect(joinNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId,
        networkId: 'network-b',
        name: 'My computer'
      })
    )
    finish({ ok: true as const, data: registered })
    await flushPromises()
    const card = ui.get('[data-testid="p2p-join-registered"]')
    expect(card.text()).toContain('device-a')
    expect(card.text()).toContain('network-b')
    expect(card.text()).toContain('已登记，尚未组网')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
    await ui.get('[data-testid="p2p-join-go-account"]').trigger('click')
    expect(wrapper!.emitted('navigate-account')).toHaveLength(1)
  })

  it('surfaces a full-network refusal as a typed error and keeps the form retryable', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: false as const,
      code: 'p2p.network_full' as const,
      message: 'network full'
    })
    const ui = await render({ joinNetwork })
    await fillJoinForm(ui, 'network-full', 'My computer')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-join-error"]')
    expect(error.text()).toContain('已达到组网设备数上限')
    expect(error.text()).toContain('p2p.network_full')
    expect(ui.find('[data-testid="p2p-join-registered"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('maps an unavailable server-side enrollment endpoint as a stub error, never a registration', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: false as const,
      code: 'p2p.invalid_operation' as const,
      message: 'server helper not wired yet'
    })
    const ui = await render({ joinNetwork })
    await fillJoinForm(ui, 'network-b', 'My computer')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-join-error"]')
    expect(error.text()).toContain('免登录登记接口')
    expect(ui.find('[data-testid="p2p-join-registered"]').exists()).toBe(false)
  })

  it('reflects an already-registered local device instead of offering a redundant join', async () => {
    const ui = await render({})
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    expect(ui.get('[data-testid="p2p-join-registered"]').text()).toContain('device-a')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  it('asks for a selected server when none is chosen', async () => {
    window.dshLauncher = {} as unknown as DesktopApi
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.catalog.value = saved
    domain.p2pManagement.selectedServiceId.value = undefined
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    expect(wrapper.text()).toContain('请先在“服务器配置”列表中点击“管理用户与网络”')
    expect(wrapper.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })
})
