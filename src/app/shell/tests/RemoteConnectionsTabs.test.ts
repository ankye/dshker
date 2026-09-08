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
const user = { userId: 'user-a', username: 'alice' }
const registration: P2PRegistrationView = {
  kind: 'registered',
  serviceId,
  userId: 'user-a',
  name: 'My computer',
  publicKey: 'public-key',
  revision: 'b'.repeat(64),
  deviceId: 'device-a'
}

function remoteApi() {
  const state = { connections: [] as never[] }
  const api: DesktopApi['remoteConnections'] = {
    getState: vi.fn(async () => ({ ok: true as const, data: state })),
    create: vi.fn(async () => ({ ok: true as const, data: state })),
    update: vi.fn(async () => ({ ok: true as const, data: state })),
    test: vi.fn(async () => ({ ok: true as const, data: state })),
    connect: vi.fn(async () => ({ ok: true as const, data: state })),
    disconnect: vi.fn(async () => ({ ok: true as const, data: state })),
    remove: vi.fn(async () => ({ ok: true as const, data: state })),
    onStateChange: () => () => undefined
  }
  return { api }
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

async function installDomains(withService: boolean) {
  const domain = await import('@/app/domains/remote-connections')
  if (withService) domain.p2pManagement.selectedServiceId.value = serviceId
  // Panels that read pairing/connection/enrollment state after login are driven
  // by dedicated domain tests; here the reads are no-ops so the composition can
  // be asserted deterministically.
  vi.spyOn(domain.p2pEnrollment, 'read').mockResolvedValue(undefined)
  vi.spyOn(domain.p2pPairing, 'read').mockResolvedValue(undefined)
  vi.spyOn(domain.p2pConnections, 'read').mockResolvedValue(undefined)
  return domain
}

async function render(api: Partial<P2PManagementApi>, withService: boolean, attachToBody = false) {
  const { api: sshApi } = remoteApi()
  const domain = await installDomains(withService)
  window.dshLauncher = {
    remoteConnections: sshApi,
    p2pManagement: api,
    bootstrap: {
      getInfo: async () => ({
        ok: false as const,
        code: 'bootstrap.bridge_unavailable' as const,
        message: 'no native bridge in this unit test'
      })
    }
  } as unknown as DesktopApi
  if (attachToBody) {
    container = document.createElement('div')
    document.body.append(container)
  }
  const component = (await import('../components/RemoteConnectionsPanel.vue')).default
  wrapper = mount(component, container ? { attachTo: container } : {})
  await flushPromises()
  return { domain }
}

function signedOutApi(): Partial<P2PManagementApi> {
  return {
    catalog: async () => ({ ok: true as const, data: saved }),
    currentUser: async () => ({
      ok: false as const,
      code: 'p2p.user_login_required' as const,
      message: 'required'
    })
  }
}

async function openAccountTab(ui: VueWrapper) {
  await ui.get('[data-testid="remote-tab-account"]').trigger('click')
  await flushPromises()
}

describe('RemoteConnectionsPanel two sub-tabs', () => {
  it('opens on the login-free Connect tab by default and keeps account content unmounted', async () => {
    await render({}, false)
    const connect = wrapper!.get('[data-testid="remote-pane-connect"]')
    expect(connect.attributes('role')).toBe('tabpanel')
    expect(wrapper!.find('[data-testid="remote-pane-account"]').exists()).toBe(false)
    expect(wrapper!.get('[data-testid="remote-tab-connect"]').attributes('data-active')).toBe(
      'true'
    )
    expect(wrapper!.get('[data-testid="remote-tab-account"]').attributes('data-active')).toBe(
      'false'
    )
    expect(connect.find('[data-testid="remote-add-form"]').exists()).toBe(true)
  })

  it('gates the Network & account tab behind login: signed out shows the login page only there', async () => {
    const { domain } = await render(signedOutApi(), true)
    expect(domain.p2pAccounts.state(serviceId).user).toBeUndefined()
    expect(wrapper!.find('[data-testid="remote-pane-account"]').exists()).toBe(false)
    // The login form must not leak into the login-free Connect tab.
    expect(wrapper!.find('input[type="password"]').exists()).toBe(false)
    await openAccountTab(wrapper!)
    const accountPane = wrapper!.get('[data-testid="remote-pane-account"]')
    expect(accountPane.find('input[autocomplete="username"]').exists()).toBe(true)
    expect(accountPane.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="remote-pane-connect"]').exists()).toBe(false)
  })

  it('shows a mesh-gate guidance for a joined-but-signed-out device and focuses the login form', async () => {
    const { domain } = await render(signedOutApi(), true, true)
    domain.p2pEnrollment.state(serviceId).registration = registration
    await flushPromises()
    await openAccountTab(wrapper!)
    const gate = wrapper!.get('[data-testid="p2p-account-mesh-gate"]')
    expect(gate.text()).toContain('尚未登录')
    await wrapper!.get('[data-testid="p2p-mesh-gate-login"]').trigger('click')
    await flushPromises()
    expect(document.activeElement?.id).toBe('p2p-login-username-' + serviceId)
  })

  it('offers an explicit path back to Connect when no server is selected', async () => {
    const { api: sshApi } = remoteApi()
    window.dshLauncher = {
      remoteConnections: sshApi,
      bootstrap: {
        getInfo: async () => ({
          ok: false as const,
          code: 'bootstrap.bridge_unavailable' as const,
          message: 'no native bridge in this unit test'
        })
      }
    } as unknown as DesktopApi
    await installDomains(false)
    const component = (await import('../components/RemoteConnectionsPanel.vue')).default
    wrapper = mount(component)
    await flushPromises()
    await openAccountTab(wrapper!)
    expect(wrapper!.find('[data-testid="p2p-account-go-connect"]').exists()).toBe(true)
    await wrapper!.get('[data-testid="p2p-account-go-connect"]').trigger('click')
    await flushPromises()
    expect(wrapper!.find('[data-testid="remote-pane-connect"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="remote-pane-account"]').exists()).toBe(false)
  })

  it('composes account, network, enrollment and pairing management once logged in', async () => {
    const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({ ok: true, data: user })
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValueOnce({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'required'
      })
      .mockResolvedValue({ ok: true, data: user })
    const { domain } = await render(
      {
        catalog: async () => ({ ok: true, data: saved }),
        currentUser,
        login
      },
      true
    )
    await openAccountTab(wrapper!)
    expect(wrapper!.find('[data-testid="p2p-enrollment"]').exists()).toBe(false)
    const pane = wrapper!.get('[data-testid="remote-pane-account"]')
    await pane.get('input[autocomplete="username"]').setValue('alice')
    await pane.get('input[type="password"]').setValue('secret')
    await pane.get('form').trigger('submit')
    await flushPromises()
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, username: 'alice', password: 'secret' })
    )
    expect(domain.p2pAccounts.state(serviceId).user?.username).toBe('alice')
    expect(pane.text()).toContain('登出')
    expect(wrapper!.find('[data-testid="p2p-enrollment"]').exists()).toBe(true)
    expect(wrapper!.find('[data-testid="p2p-pairing-panel"]').exists()).toBe(true)
    expect(wrapper!.find('input[type="password"]').exists()).toBe(false)
  })
})
