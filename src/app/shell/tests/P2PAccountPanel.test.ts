import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PDirectoryView, P2PManagementApi } from '@/shared/p2p-management'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'

const user = { userId: 'user-a', username: 'alice' }
const network = { networkId: 'net-a', userId: user.userId, name: 'Office', maxDevices: 10 }
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
async function render(api: Partial<P2PManagementApi>) {
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const panel = (await import('../components/P2PAccountPanel.vue')).default
  container = document.createElement('div')
  document.body.append(container)
  wrapper = mount(panel, {
    attachTo: container,
    props: { serviceId: 'service-a', displayName: 'Home' }
  })
  await flushPromises()
  return wrapper
}
function button(ui: VueWrapper, text: string) {
  const found = ui.findAll('button').find((node) => node.text() === text)
  if (!found) throw new Error(`Missing public button: ${text}`)
  return found
}

/** The answer a core gives for an account whose only network has no members yet. */
function emptyDirectory(net: typeof network, userId: string): P2PDirectoryView {
  return {
    known: true,
    revision: 1,
    fetchedAt: 1_789_000_000,
    networks: [
      {
        networkId: net.networkId,
        userId,
        name: net.name,
        maxDevices: net.maxDevices,
        devices: []
      }
    ],
    devices: []
  }
}

describe('P2P account public controls (component diagnostics)', () => {
  /**
   * The directory has one owner — the core — and the panel reads that snapshot on
   * open rather than asking the coordinator for one of its own. A cached answer
   * kept from a previous visit is exactly what made the list look frozen with a
   * row that still said "never reported".
   */
  it('reads the core directory on open instead of reusing a cached snapshot', async () => {
    const directory = vi.fn<P2PManagementApi['directory']>().mockResolvedValue({
      ok: true,
      data: {
        known: true,
        revision: 4,
        fetchedAt: 1_789_000_000,
        networks: [
          {
            networkId: network.networkId,
            userId: user.userId,
            name: network.name,
            maxDevices: network.maxDevices,
            devices: [
              {
                deviceId: 'a'.repeat(12),
                name: 'USER-20260612LO',
                presence: 'online',
                lastSeen: 1_789_000_000,
                version: '0.1.42',
                platform: 'win32',
                architecture: 'x64',
                isLocal: true
              }
            ]
          }
        ],
        devices: []
      }
    })
    window.dshLauncher = {
      p2pManagement: {
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: true, data: [network] }),
        directory
      }
    } as unknown as DesktopApi
    const domain = await import('@/app/domains/remote-connections')
    domain.p2pAccounts.state('service-a').selectedNetworkId = network.networkId
    // A stale row from a previous visit is what the pane used to show again.
    domain.p2pAccounts.state('service-a').devices[network.networkId] = []
    expect(directory).not.toHaveBeenCalled()

    const panel = (await import('../components/P2PAccountPanel.vue')).default
    container = document.createElement('div')
    document.body.append(container)
    wrapper = mount(panel, {
      attachTo: container,
      props: { serviceId: 'service-a', displayName: 'Home' }
    })
    await flushPromises()

    expect(directory).toHaveBeenCalledTimes(1)
    expect(domain.p2pAccounts.state('service-a').devices[network.networkId]?.[0]?.name).toBe(
      'USER-20260612LO'
    )
    expect(wrapper?.text()).toContain('USER-20260612LO')
  })

  it('asks the core to read the coordinator again from the refresh control', async () => {
    const refreshDirectory = vi
      .fn<P2PManagementApi['refreshDirectory']>()
      .mockResolvedValue({ ok: true, data: emptyDirectory(network, user.userId) })
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks: async () => ({ ok: true, data: [network] }),
      refreshDirectory
    })
    expect(refreshDirectory).not.toHaveBeenCalled()
    await ui.get('[data-testid="p2p-devices-refresh"]').trigger('click')
    await flushPromises()
    expect(refreshDirectory).toHaveBeenCalledTimes(1)
  })

  it('keeps identity and editing details collapsed while exposing a scannable network row', async () => {
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks: async () => ({ ok: true, data: [network] })
    })
    const row = ui.get('.p2p-network-row')
    expect(row.text()).toContain('Office')
    expect(row.text()).toContain('10 台')
    expect(row.text()).not.toContain(network.networkId)
    expect(ui.get('.p2p-account-identity details').attributes('open')).toBeUndefined()
    expect(ui.get('.p2p-network-toggle').attributes('aria-expanded')).toBe('false')
    expect(ui.get('.p2p-network-editor .p2p-technical-details code').text()).toBe(network.networkId)
    await ui.get('.p2p-network-toggle').trigger('click')
    expect(ui.get('.p2p-network-toggle').attributes('aria-expanded')).toBe('true')
    expect(ui.get('.p2p-network-editor-body').isVisible()).toBe(true)
    expect(ui.get('.p2p-network-create').attributes('open')).toBeUndefined()
    expect(ui.findAll('.p2p-network-row button')).toHaveLength(0)
  })

  it('clears submitted passwords and selects the only network without a click', async () => {
    const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({ ok: true, data: user })
    const networks = vi
      .fn<P2PManagementApi['networks']>()
      .mockResolvedValue({ ok: true, data: [network] })
    const ui = await render({
      currentUser: async () => ({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'required'
      }),
      login,
      networks
    })
    const loginForm = ui.get('[data-testid="p2p-login-form"]')
    await loginForm.get('input[autocomplete="username"]').setValue('alice')
    await loginForm.get('input[type="password"]').setValue('secret-login')
    await loginForm.trigger('submit')
    await flushPromises()
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        username: 'alice',
        password: 'secret-login'
      })
    )
    expect(ui.find('input[type="password"]').exists()).toBe(false)
    expect(ui.text()).toContain(user.userId)
    // A confirmed session loads its own networks. The panel exists to show them,
    // so it must not require a click to display what the session already grants.
    expect(networks).toHaveBeenCalledTimes(1)
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    expect(ui.find('[data-testid="p2p-register-form"]').exists()).toBe(false)
    expect(ui.get('.p2p-network-list').text()).toContain(network.networkId)
    expect(ui.get('.p2p-network-list').text()).toContain(network.name)
    // One network is not a choice, so the panel must not ask for a click whose
    // answer it already knows.
    expect((ui.get('input[type="radio"]').element as HTMLInputElement).checked).toBe(true)
    expect(ui.text()).toContain('选定网络: Office')
    const { p2pAccounts } = await import('@/app/domains/remote-connections')
    expect(p2pAccounts.state('service-a').selectedNetworkId).toBe(network.networkId)
    expect(JSON.stringify(p2pAccounts.state('service-a'))).not.toContain('secret-login')
  })

  it('previews exact network deletion, blocks unconfirmed re-submission and resolves through readback', async () => {
    const networks = vi
      .fn<P2PManagementApi['networks']>()
      .mockResolvedValue({ ok: true, data: [network] })
    const deleteNetwork = vi.fn<P2PManagementApi['deleteNetwork']>().mockResolvedValue({
      ok: false,
      code: 'p2p.management_result_unconfirmed',
      message: 'unconfirmed'
    })
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks,
      deleteNetwork
    })
    await ui.get('.p2p-network-toggle').trigger('click')
    expect(button(ui, '删除网络').isVisible()).toBe(true)
    await button(ui, '删除网络').trigger('click')
    expect(deleteNetwork).not.toHaveBeenCalled()
    const confirmation = ui.get('.p2p-delete-confirm')
    expect(document.activeElement).toBe(confirmation.get('button').element)
    expect(confirmation.text()).toContain('Office · net-a')
    expect(confirmation.text()).toContain('撤销此网络的设备绑定和配对授权')
    await confirmation.get('button').trigger('click')
    await flushPromises()
    expect(deleteNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', networkId: 'net-a' })
    )
    expect(ui.get('.p2p-delete-confirm button').attributes('disabled')).toBeDefined()
    await button(ui, '刷新账户').trigger('click')
    await flushPromises()
    expect(ui.get('.p2p-delete-confirm button').attributes('disabled')).toBeDefined()
    // The unconfirmed write is resolved by re-reading the authoritative record,
    // which is the manual refresh this panel keeps for exactly this purpose.
    networks.mockResolvedValueOnce({ ok: true, data: [] })
    await button(ui, '刷新网络列表').trigger('click')
    await flushPromises()
    expect(ui.find('.p2p-delete-confirm').exists()).toBe(false)
    expect(document.activeElement).toBe(ui.get('h3').element)
    expect(ui.findAll('.p2p-network-list li')).toHaveLength(0)
    expect(ui.text()).toContain('此用户没有网络')
    expect(deleteNetwork).toHaveBeenCalledTimes(1)
  })

  it('submits create and rename forms with original identities and displays returned names', async () => {
    const renamed = { ...network, name: 'Office updated' }
    const created = { ...network, networkId: 'net-new', name: 'Lab' }
    const renameNetwork = vi
      .fn<P2PManagementApi['renameNetwork']>()
      .mockResolvedValue({ ok: true, data: renamed })
    const createNetwork = vi
      .fn<P2PManagementApi['createNetwork']>()
      .mockResolvedValue({ ok: true, data: created })
    const ui = await render({
      currentUser: async () => ({ ok: true, data: user }),
      networks: async () => ({ ok: true, data: [network] }),
      renameNetwork,
      createNetwork
    })
    await ui.get('.p2p-network-toggle').trigger('click')
    const rename = ui.get('.p2p-network-list form')
    expect((rename.get('input').element as HTMLInputElement).value).toBe('Office')
    await rename.get('input').setValue('Office updated')
    await rename.trigger('submit')
    await flushPromises()
    expect(renameNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'service-a',
        networkId: 'net-a',
        name: 'Office updated'
      })
    )
    const create = ui.findAll('form').at(-1)!
    await create.get('input').setValue('Lab')
    await create.trigger('submit')
    await flushPromises()
    expect(createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: 'service-a', name: 'Lab' })
    )
    expect(ui.findAll('.p2p-network-list li').map((node) => node.get('label').text())).toEqual([
      'Office updated',
      'Lab'
    ])
    expect(ui.text()).toContain('net-new')
    // The selection stays on the network that was read first: adding a second one
    // neither clears it nor moves it to the newcomer.
    expect(
      ui.findAll('input[type="radio"]').map((node) => (node.element as HTMLInputElement).checked)
    ).toEqual([true, false])
  })

  describe('P2P network device capacity control', () => {
    it('raises an owned network limit through the dedicated control and applies the readback', async () => {
      const raised = { ...network, maxDevices: 20 }
      const updateNetworkLimit = vi
        .fn<P2PManagementApi['updateNetworkLimit']>()
        .mockResolvedValue({ ok: true, data: raised })
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: true, data: [network] }),
        updateNetworkLimit
      })
      await ui.get('.p2p-network-toggle').trigger('click')
      expect(ui.get('[data-testid="p2p-network-limit"]').text()).toContain('10')
      // The themed listbox renders its rows on open, so the trigger is opened first.
      await ui.get('[data-testid="p2p-limit"]').trigger('click')
      await flushPromises()
      expect(ui.findAll('[role="option"]').map((option) => option.text())).toEqual(['20', '30'])
      await ui.get('[data-testid="p2p-limit-save"]').trigger('click')
      await flushPromises()
      expect(updateNetworkLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: 'service-a',
          networkId: 'net-a',
          maxDevices: 20
        })
      )
      expect(ui.get('[data-testid="p2p-network-limit"]').text()).toContain('20')
    })

    it('offers no raise control once a network is at the maximum of 30', async () => {
      const atMax = { ...network, maxDevices: 30 }
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: true, data: [atMax] })
      })
      expect(ui.get('[data-testid="p2p-network-limit"]').text()).toContain('30')
      expect(ui.find('[data-testid="p2p-limit"]').exists()).toBe(false)
      expect(ui.text()).toContain('已达最大上限 30')
    })

    it('never shows the raise control for a network owned by someone else', async () => {
      const foreign = { ...network, userId: 'other-user' }
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: true, data: [foreign] })
      })
      expect(ui.get('[data-testid="p2p-network-limit"]').text()).toContain('10')
      expect(ui.find('[data-testid="p2p-limit"]').exists()).toBe(false)
    })
  })

  describe('Account registration form', () => {
    it('treats being signed out as a fact, not a failed operation', async () => {
      const currentUser = vi.fn<P2PManagementApi['currentUser']>().mockResolvedValue({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'required'
      })
      const ui = await render({ currentUser })
      expect(currentUser).toHaveBeenCalled()
      // No alert: 'login required' is the normal state before signing in.
      expect(ui.find('[data-testid="p2p-account-error"]').exists()).toBe(false)
      expect(ui.text()).not.toContain('p2p.user_login_required')
      // Re-reading the user is meaningless before a session exists.
      expect(ui.find('[data-testid="p2p-account-read-user"]').exists()).toBe(false)
    })

    it('still reports a genuine failure and offers the user re-read once signed in', async () => {
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: false, code: 'p2p.helper_unavailable', message: 'down' })
      })
      expect(ui.find('[data-testid="p2p-account-read-user"]').exists()).toBe(true)
      const error = ui.get('[data-testid="p2p-account-error"]')
      expect(error.text()).toContain('p2p.helper_unavailable')
    })

    it('explains a rejected value instead of blaming the configuration', async () => {
      // A refused input used to produce "check your configuration" plus a bare
      // code, which pointed the user at something that was not wrong.
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: false, code: 'p2p.invalid_request', message: 'refused' })
      })
      const error = ui.get('[data-testid="p2p-account-error"]')
      expect(error.text()).toContain(zhCN['p2p.account.invalidInput'])
      expect(error.text()).not.toContain(zhCN['p2p.management.failed'])
      // The code stays available for reporting, just no longer alone.
      expect(error.text()).toContain('p2p.invalid_request')
    })

    it('offers a category message for a code that has no specific copy', async () => {
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: false, code: 'p2p.service_busy', message: 'busy' })
      })
      // Transient refusals invite a retry rather than a configuration audit.
      expect(ui.get('[data-testid="p2p-account-error"]').text()).toContain(
        zhCN['p2p.refusal.retry']
      )
    })

    it('never asks for a password while the account state is unknown', async () => {
      // Unknown is not signed out. The panel used to show the 'unknown' line and
      // the password form together, asking for a secret it could not yet use.
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.helper_resource_unavailable',
          message: 'no helper'
        })
      })
      expect(ui.text()).toContain(zhCN['p2p.account.unknown'])
      expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
      expect(ui.find('input[type="password"]').exists()).toBe(false)
    })

    it('keeps a way out when the account state is unknown', async () => {
      // With no identity to act on and no form to submit, hiding the read button
      // left the panel with no control at all: only restarting the app recovered.
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.helper_resource_unavailable',
          message: 'no helper'
        })
      })
      expect(ui.find('[data-testid="p2p-account-read-user"]').exists()).toBe(true)
    })

    it('offers the credential forms only once sign-out is confirmed', async () => {
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'none'
        })
      })
      // A confirmed sign-out is exactly when asking for credentials is correct.
      expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
      expect(ui.text()).not.toContain(zhCN['p2p.account.unknown'])
    })

    it('does not report an unregistered device as a failure', async () => {
      // Nothing stored yet is the normal state before enrollment.
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.credential_unavailable',
          message: 'none'
        })
      })
      expect(ui.find('[data-testid="p2p-account-error"]').exists()).toBe(false)
    })

    it('shows one auth form at a time and switches between login and register', async () => {
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        })
      })
      // Signed out opens on login alone; register is one link away.
      expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
      expect(ui.find('[data-testid="p2p-register-form"]').exists()).toBe(false)
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      expect(ui.find('[data-testid="p2p-register-form"]').exists()).toBe(true)
      expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
      await ui.get('[data-testid="p2p-account-switch-login"]').trigger('click')
      expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
      expect(ui.find('[data-testid="p2p-register-form"]').exists()).toBe(false)
    })

    it('keeps the login and register email drafts independent', async () => {
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        })
      })
      await ui.get('input[autocomplete="username"]').setValue('login@example.com')
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      // A shared draft used to let one form silently rewrite the other's email.
      expect((ui.get('[data-testid="p2p-register-email"]').element as HTMLInputElement).value).toBe(
        ''
      )
      await ui.get('[data-testid="p2p-register-email"]').setValue('new@example.com')
      await ui.get('[data-testid="p2p-account-switch-login"]').trigger('click')
      expect((ui.get('input[autocomplete="username"]').element as HTMLInputElement).value).toBe(
        'login@example.com'
      )
    })

    it('states the password requirement and refuses a short one before any request', async () => {
      const register = vi.fn<P2PManagementApi['register']>()
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        }),
        register
      })
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      // The requirement is stated up front, not discovered by failing.
      expect(ui.text()).toContain('密码至少 12 位')
      const form = ui.get('[data-testid="p2p-register-form"]')
      await form.get('input[autocomplete="email"]').setValue('alice@example.com')
      await form.get('[data-testid="p2p-register-password"]').setValue('too-short')
      expect(ui.find('[data-testid="p2p-register-too-short"]').exists()).toBe(true)
      await form.trigger('submit')
      await flushPromises()
      // A password the coordinator would refuse never leaves the renderer.
      expect(register).not.toHaveBeenCalled()
      await form.get('[data-testid="p2p-register-password"]').setValue('a-long-password')
      expect(ui.find('[data-testid="p2p-register-too-short"]').exists()).toBe(false)
    })

    it('explains a credential refusal from the server in readable terms', async () => {
      const register = vi.fn<P2PManagementApi['register']>().mockResolvedValue({
        ok: false,
        code: 'p2p.invalid_user_credentials',
        message: 'refused'
      })
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        }),
        register
      })
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      const form = ui.get('[data-testid="p2p-register-form"]')
      await form.get('input[autocomplete="email"]').setValue('alice@example.com')
      await form.get('[data-testid="p2p-register-password"]').setValue('a-long-password')
      await form.trigger('submit')
      await flushPromises()
      const error = ui.get('[data-testid="p2p-account-error"]')
      expect(error.text()).toContain('服务器拒绝了这组邮箱或密码')
      expect(error.text()).toContain('p2p.invalid_user_credentials')
    })

    it('registers with its own email and adopts the registered user', async () => {
      const register = vi.fn<P2PManagementApi['register']>().mockResolvedValue({
        ok: true,
        data: user
      })
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        }),
        register
      })
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      const form = ui.get('[data-testid="p2p-register-form"]')
      expect(form.text()).toContain('注册账号')
      await form.get('input[autocomplete="email"]').setValue('alice@example.com')
      await form.get('[data-testid="p2p-register-password"]').setValue('a-long-new-secret')
      await form.trigger('submit')
      await flushPromises()
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          serviceId: 'service-a',
          email: 'alice@example.com',
          password: 'a-long-new-secret'
        })
      )
      expect(ui.text()).toContain(user.userId)
      expect(ui.find('[data-testid="p2p-register-password"]').exists()).toBe(false)
      const { p2pAccounts } = await import('@/app/domains/remote-connections')
      expect(JSON.stringify(p2pAccounts.state('service-a'))).not.toContain('a-long-new-secret')
    })

    it('shows a localized message when create-network is refused due to the network limit', async () => {
      const createNetwork = vi.fn<P2PManagementApi['createNetwork']>().mockResolvedValue({
        ok: false,
        code: 'p2p.network_limit_reached',
        message: 'limit'
      })
      const ui = await render({
        currentUser: async () => ({ ok: true, data: user }),
        networks: async () => ({ ok: true, data: [network] }),
        createNetwork
      })
      const create = ui.findAll('form').at(-1)!
      await create.get('input').setValue('Third')
      await create.trigger('submit')
      await flushPromises()
      const error = ui.get('[data-testid="p2p-account-error"]')
      expect(error.text()).toContain('每个账号最多创建 2 个网络')
      expect(error.text()).toContain('p2p.network_limit_reached')
    })

    it('shows a localized message when registration is refused because the email exists', async () => {
      const register = vi.fn<P2PManagementApi['register']>().mockResolvedValue({
        ok: false,
        code: 'p2p.user_conflict',
        message: 'duplicate'
      })
      const ui = await render({
        currentUser: async () => ({
          ok: false,
          code: 'p2p.user_login_required',
          message: 'required'
        }),
        register
      })
      await ui.get('[data-testid="p2p-account-switch-register"]').trigger('click')
      const form = ui.get('[data-testid="p2p-register-form"]')
      await form.get('input[autocomplete="email"]').setValue('existing@example.com')
      await form.get('[data-testid="p2p-register-password"]').setValue('a-long-password')
      await form.trigger('submit')
      await flushPromises()
      const error = ui.get('[data-testid="p2p-account-error"]')
      expect(error.text()).toContain('该邮箱已注册过账号')
      expect(error.text()).toContain('p2p.user_conflict')
    })
  })
})
