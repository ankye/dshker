import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import { P2P_BUILTIN_SERVICE, type P2PManagementApi } from '@/shared/p2p-management'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'

/**
 * The signed-in card mounts the account, enrollment and pairing panels together
 * and each one reads on entry. Reads for the same service share one busy scope,
 * so a concurrent read is refused with p2p.service_busy and the domain returns
 * without recording anything, leaving the surface claiming it holds no data.
 *
 * No existing test mounted these panels together, which is how the interaction
 * between their entry reads stayed unverified.
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
    const pairs = vi.fn<P2PManagementApi['pairs']>().mockResolvedValue({ ok: true, data: [] })

    const ui = await renderCard({
      catalog: async () => ({ ok: true, data: catalog }),
      currentUser: async () => ({ ok: true, data: user }),
      networks,
      registration,
      pairs,
      connections: async () => ({ ok: true, data: { error: '', peers: [] } })
    })

    // The card must actually reach the signed-in state, or the counts below
    // would be trivially zero and prove nothing.
    expect(ui.text()).toContain(user.username)
    expect(networks).toHaveBeenCalledTimes(1)
    expect(registration).toHaveBeenCalledTimes(1)
    expect(pairs).toHaveBeenCalledTimes(1)
    // The surfaces show loaded data rather than an "not loaded yet" notice.
    expect(ui.text()).toContain(network.name)
    expect(ui.text()).not.toContain(zhCN['p2p.enrollment.unknown'])
    expect(ui.text()).not.toContain(zhCN['p2p.account.networksUnknown'])
  })
})
