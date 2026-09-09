import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import {
  P2P_BUILTIN_SERVICE,
  type P2PCatalogView,
  type P2PManagementApi,
  type P2PRegistrationView
} from '@/shared/p2p-management'

const serviceId = 'a'.repeat(64)
const service = {
  serviceId,
  publicKey: 'pinned-key',
  displayName: P2P_BUILTIN_SERVICE.displayName,
  httpsOrigin: P2P_BUILTIN_SERVICE.httpsOrigin,
  wssUrl: P2P_BUILTIN_SERVICE.wssUrl,
  stunAddress: P2P_BUILTIN_SERVICE.stunAddress
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
const pending: P2PRegistrationView = {
  kind: 'pending',
  serviceId,
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'a'.repeat(64),
  requestId: 'original-request',
  networkId: 'network-a'
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

/** Mounts with the built-in service catalog and selection pre-set. */
async function render(api: Partial<P2PManagementApi>) {
  const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
    ok: true,
    data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
  })
  window.dshLauncher = { p2pManagement: { ...api, localDevice } } as unknown as DesktopApi
  const domain = await import('@/app/domains/remote-connections')
  domain.p2pManagement.catalog.value = saved
  domain.p2pManagement.selectedServiceId.value = serviceId
  const component = (await import('../components/P2PJoinPanel.vue')).default
  wrapper = mount(component)
  await flushPromises()
  return wrapper
}

describe('P2P 「我的网络」 card', () => {
  it('provisions the built-in official server automatically on mount', async () => {
    const catalog = vi.fn<P2PManagementApi['catalog']>().mockResolvedValue({
      ok: true,
      data: saved
    })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = {
      p2pManagement: { catalog, localDevice }
    } as unknown as DesktopApi
    const domain = await import('@/app/domains/remote-connections')
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    expect(catalog).toHaveBeenCalled()
    expect(domain.p2pManagement.selectedServiceId.value).toBe(serviceId)
    expect(domain.p2pManagement.builtinProvisioned.value).toBe(true)
    expect(wrapper.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('always shows the device name and identifier, with no endpoint inputs', async () => {
    const ui = await render({})
    const info = ui.get('[data-testid="p2p-device-info"]')
    expect(info.text()).toContain('设备名称')
    expect(info.text()).toContain('设备标识')
    // Before joining, the card shows this machine's generated local device id.
    expect(info.text()).toContain('local-device-a')
    expect(ui.find('input[name]').exists()).toBe(false)
    expect(ui.findAll('input')).toHaveLength(1)
    expect((ui.get('[data-testid="p2p-join-network"]').element as HTMLInputElement).type).toBe(
      'text'
    )
  })

  it('flows not-joined -> pending -> not-joined again after a confirmed cancel', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: true,
      data: pending
    })
    const registration = vi.fn<P2PManagementApi['registration']>().mockResolvedValue({
      ok: false,
      code: 'p2p.credential_unavailable',
      message: 'nothing stored'
    })
    const ui = await render({ joinNetwork, registration })
    // Not joined: join form with a single network ID input.
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-join-network"]').setValue('network-a')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    expect(joinNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, networkId: 'network-a' })
    )
    // Pending: input greyed out, cancel button, waiting-for-approval status.
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    const disabled = ui.get('[data-testid="p2p-pending-network"]')
    expect((disabled.element as HTMLInputElement).disabled).toBe(true)
    expect(ui.get('[data-testid="p2p-pending-status"]').text()).toContain('等待审批')
    // Cancel with a readback that proves no registration clears the pending draft.
    await ui.get('[data-testid="p2p-cancel-request"]').trigger('click')
    await flushPromises()
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('keeps the pending state when the readback still reports a registration', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>()
    const registration = vi.fn<P2PManagementApi['registration']>().mockResolvedValue({
      ok: true,
      data: pending
    })
    const ui = await render({ joinNetwork, registration })
    // The mount readback reports a pending registration: the card starts pending.
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-cancel-request"]').trigger('click')
    await flushPromises()
    // The readback still holds the pending enrollment, so nothing is cleared.
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(true)
    expect(joinNetwork).not.toHaveBeenCalled()
  })

  it('shows the registered card with no input, honest offline status and a leave action', async () => {
    const ui = await render({})
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    domain.p2pEnrollment.state(serviceId).joinNetworkIdDraft = 'network-a'
    await flushPromises()
    const info = ui.get('[data-testid="p2p-device-info"]')
    expect(info.text()).toContain('My computer')
    expect(info.text()).toContain('device-a')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-pending-state"]').exists()).toBe(false)
    // Offline unless a live ready connection stage proves otherwise.
    expect(ui.get('[data-testid="p2p-network-status"]').text()).toContain('离线')
    expect(ui.find('[data-testid="p2p-leave-network"]').exists()).toBe(true)
  })

  it('offers no leave without a session and says why, rather than failing on click', async () => {
    const leaveNetwork = vi.fn<P2PManagementApi['leaveNetwork']>()
    const ui = await render({ leaveNetwork })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pEnrollment.state(serviceId).registration = registered
    await flushPromises()
    // The coordinator has no login-free removal, so the action is unavailable
    // until the owner signs in. The reason is stated, not left to be guessed.
    expect(ui.get('[data-testid="p2p-leave-network"]').attributes('disabled')).toBeDefined()
    expect(ui.find('[data-testid="p2p-leave-requires-login"]').exists()).toBe(true)
    await ui.get('[data-testid="p2p-leave-network"]').trigger('click')
    await flushPromises()
    expect(leaveNetwork).not.toHaveBeenCalled()
  })

  it('leaves with the owner session and surfaces a refusal without dropping the registration', async () => {
    const leaveNetwork = vi.fn<P2PManagementApi['leaveNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.network_unauthorized',
      message: 'refused'
    })
    const ui = await render({ leaveNetwork })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pAccounts.state(serviceId).user = { userId: 'u'.repeat(32), username: 'owner' }
    domain.p2pEnrollment.state(serviceId).registration = registered
    domain.p2pEnrollment.state(serviceId).joinNetworkIdDraft = 'network-a'
    await flushPromises()
    expect(ui.find('[data-testid="p2p-leave-requires-login"]').exists()).toBe(false)
    await ui.get('[data-testid="p2p-leave-network"]').trigger('click')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-leave-error"]')
    expect(error.text()).toContain('p2p.network_unauthorized')
    // A refused removal must not look like a completed one.
    expect(ui.find('[data-testid="p2p-joined-state"]').exists()).toBe(true)
    expect(leaveNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, networkId: 'network-a', deviceId: 'device-a' })
    )
  })

  it('surfaces a full-network refusal as a typed error and keeps the form retryable', async () => {
    const joinNetwork = vi.fn<P2PManagementApi['joinNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.network_full',
      message: 'network full'
    })
    const ui = await render({ joinNetwork })
    await ui.get('[data-testid="p2p-join-network"]').setValue('network-full')
    await ui.get('[data-testid="p2p-join-form"]').trigger('submit')
    await flushPromises()
    const error = ui.get('[data-testid="p2p-join-error"]')
    expect(error.text()).toContain('已达到组网设备数上限')
    expect(error.text()).toContain('p2p.network_full')
    expect(ui.find('[data-testid="p2p-joined-state"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(true)
  })

  it('shows the unavailable state when the catalog holds no official server', async () => {
    // The catalog was read successfully and simply has no built-in service, and
    // adding one is refused: that is 'unavailable', not a read failure.
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: true, data: { ...saved, services: [] } })
    const addService = vi
      .fn<P2PManagementApi['addService']>()
      .mockResolvedValue({ ok: false, code: 'p2p.catalog_conflict', message: 'conflict' })
    const ui = await render({ catalog, addService })
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.catalog.value = { ...saved, services: [] }
    domain.p2pManagement.selectedServiceId.value = undefined
    await flushPromises()
    expect(ui.get('[data-testid="p2p-service-unavailable"]').text()).toContain('官方服务器暂不可用')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  it('surfaces a catalog read failure as retryable instead of claiming no configuration', async () => {
    // A failed read must never look like 'not configured'.
    const catalog = vi
      .fn<P2PManagementApi['catalog']>()
      .mockResolvedValue({ ok: false, code: 'p2p.request_replayed', message: 'replayed' })
    const localDevice = vi.fn<P2PManagementApi['localDevice']>().mockResolvedValue({
      ok: true,
      data: { deviceId: 'local-device-a'.padEnd(32, 'a'), name: 'My mac' }
    })
    window.dshLauncher = { p2pManagement: { catalog, localDevice } } as unknown as DesktopApi
    const component = (await import('../components/P2PJoinPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    const error = wrapper.get('[data-testid="p2p-catalog-error"]')
    expect(error.text()).toContain('p2p.request_replayed')
    expect(error.find('button').exists()).toBe(true)
    expect(wrapper.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })

  it('shows the terminal removed state for a forgotten official server', async () => {
    const ui = await render({})
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pManagement.builtinRemoved.value = true
    await flushPromises()
    expect(ui.get('[data-testid="p2p-builtin-removed"]').text()).toContain('官方服务器已被移除')
    expect(ui.find('[data-testid="p2p-join-form"]').exists()).toBe(false)
  })
})
