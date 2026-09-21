import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import { P2P_BUILTIN_SERVICE, type P2PManagementApi } from '@/shared/p2p-management'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'

/**
 * The signed-in card owns the account/network workflow. Enrollment recovery and
 * pairing are not default surfaces: network membership already supplies the
 * device directory, while connection actions remain in the connection workflow.
 */
const user = { userId: 'user-a', username: 'alice' }
const network = { networkId: 'net-a', userId: user.userId, name: 'Office', maxDevices: 10 }
const service = {
  ...P2P_BUILTIN_SERVICE,
  serviceId: 'service-a',
  publicKey: 'key-a'
}
const catalog = {
  revision: 'rev-1',
  catalogId: 'catalog-a',
  services: [service],
  computers: [],
  forgottenServiceIds: []
}

let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  container?.remove()
  container = undefined
  window.dshLauncher = previous
})

async function renderCard(api: Partial<P2PManagementApi>) {
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const panel = (await import('../components/P2PNetworkAccountPanel.vue')).default
  container = document.createElement('div')
  document.body.append(container)
  wrapper = mount(panel, { attachTo: container })
  // Entry reads chain through provisioning, the session, then the per-panel
  // reads that only mount once the session is confirmed.
  for (let settle = 0; settle < 8; settle += 1) await flushPromises()
  return wrapper
}

describe('signed-in card concurrent entry reads', () => {
  it('keeps the account tab as one surfaced card without a duplicate page heading', async () => {
    const ui = await renderCard({
      catalog: async () => ({ ok: true, data: null }),
      localDevice: async () => ({
        ok: true,
        data: { deviceId: 'local-device-a', name: 'This Mac' }
      }),
      serviceSessions: async () => ({ ok: true, data: [] })
    })

    const panel = ui.get('[data-testid="p2p-network-account-panel"]')
    expect(panel.classes()).toContain('remote-add-card')
    expect(panel.text()).not.toContain(zhCN['p2p.tabs.account'])
  })

  it('keeps device identity and a disabled login form visible while the service is unavailable', async () => {
    const ui = await renderCard({
      catalog: async () => ({ ok: true, data: null }),
      localDevice: async () => ({
        ok: true,
        data: { deviceId: 'local-device-a', name: 'This Mac' }
      }),
      serviceSessions: async () => ({ ok: true, data: [] })
    })

    expect(ui.find('[data-testid="p2p-device-info"]').exists()).toBe(true)
    expect(ui.get('[data-testid="p2p-device-info"]').text()).toContain('This Mac')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
    expect(
      (ui.get('[data-testid="p2p-login-form"] fieldset').element as HTMLFieldSetElement).disabled
    ).toBe(true)
  })

  it('records every entry read instead of losing one to a busy refusal', async () => {
    const networks = vi
      .fn<P2PManagementApi['networks']>()
      .mockResolvedValue({ ok: true, data: [network] })
    const registration = vi.fn<P2PManagementApi['registration']>().mockResolvedValue({
      ok: true,
      data: {
        serviceId: service.serviceId,
        kind: 'registered',
        deviceId: 'device-a',
        name: 'This Mac',
        userId: user.userId,
        publicKey: 'device-key',
        revision: 'rev-1'
      }
    })
    const ui = await renderCard({
      catalog: async () => ({ ok: true, data: catalog }),
      currentUser: async () => ({ ok: true, data: user }),
      networks,
      registration,
      connections: async () => ({ ok: true, data: { error: '', peers: [] } })
    })

    // The card must actually reach the signed-in state, or the counts below
    // would be trivially zero and prove nothing.
    expect(ui.text()).toContain(user.username)
    expect(networks).toHaveBeenCalledTimes(1)
    expect(registration).toHaveBeenCalledTimes(1)
    // Membership is loaded into the account workflow; enrollment and pairing are
    // deliberately not mounted as duplicate full-page panels.
    expect(ui.find('[data-testid="p2p-enrollment"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-pairing-panel"]').exists()).toBe(false)
    // The account surface shows loaded data rather than an "not loaded yet" notice.
    expect(ui.text()).toContain(network.name)
    expect(ui.text()).not.toContain(zhCN['p2p.enrollment.unknown'])
    expect(ui.text()).not.toContain(zhCN['p2p.account.networksUnknown'])
  })
})
