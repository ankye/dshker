import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'
import { enUS } from '@/app/shared/i18n/messages.en-US'
import type { MessageKey } from '@/app/shared/i18n/i18n'

const serviceId = 'a'.repeat(12)
const otherServiceId = 'b'.repeat(12)
const user = { userId: 'c'.repeat(12), username: 'owner@example.test' }
let previous: DesktopApi | undefined
let wrapper: VueWrapper | undefined

beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  const { p2pAccounts } = await import('@/app/domains/remote-connections')
  p2pAccounts.stop()
  window.dshLauncher = previous
})

/** The real shell adapter and account component observe the same singleton domain. */
async function render(overrides: Partial<P2PManagementApi>) {
  const api = {
    networks: vi.fn<P2PManagementApi['networks']>().mockResolvedValue({ ok: true, data: [] }),
    ...overrides
  }
  window.dshLauncher = { p2pManagement: api } as unknown as DesktopApi
  const domain = await import('@/app/domains/remote-connections')
  const { useP2PAccountSession } = await import('../useP2PAccountSession')
  const { useTranslator } = await import('@/app/shared/i18n/useLocale')
  const Statusbar = (await import('../components/ShellStatusbar.vue')).default
  const AccountPanel = (await import('../components/P2PAccountPanel.vue')).default
  domain.p2pManagement.selectedServiceId.value = serviceId
  wrapper = mount(
    defineComponent({
      setup() {
        const session = useP2PAccountSession(domain.p2pManagement.selectedServiceId)
        const t = useTranslator()
        return () =>
          h('main', [
            h(Statusbar, {
              launcherVersionLabel: 'DSHKer',
              launcherVersion: 'test',
              dshVersionLabel: 'DSH',
              dshVersion: 'test',
              dshVersionTitle: 'test',
              runtimeLabel: 'Runtime',
              runtimeValue: 'Stopped',
              runtimeState: 'stopped',
              networkLabel: t('footer.account'),
              networkValue: t(session.labelKey.value),
              networkState: session.indicator.value,
              sidebarState: 'expanded',
              collapseLabel: 'Collapse',
              hideLabel: 'Hide',
              expandLabel: 'Expand',
              menuLabel: 'Menu',
              consoleLabel: 'Console',
              consoleControlLabel: 'Console',
              consoleUnreadLabel: 'New output',
              consoleOpen: false,
              consoleUnread: false
            }),
            h(AccountPanel, {
              key: domain.p2pManagement.selectedServiceId.value,
              serviceId: domain.p2pManagement.selectedServiceId.value!,
              displayName: 'Pinned service'
            })
          ])
      }
    })
  )
  await flushPromises()
  return { ui: wrapper, api, domain }
}

function expectBoth(ui: VueWrapper, label: string, indicator: string): void {
  expect(ui.get('.statusbar-network .statusbar-fact-value').text()).toBe(label)
  expect(ui.get('[data-testid="p2p-account-session-status"]').text()).toBe(label)
  expect(ui.get('.statusbar-network').attributes('data-state')).toBe(indicator)
}

async function expectEnglish(ui: VueWrapper, key: MessageKey, indicator: string): Promise<void> {
  const { setLocale } = await import('@/app/shared/i18n/useLocale')
  expect(ui.get('.statusbar-network .statusbar-fact-label').text()).toBe(zhCN['footer.account'])
  setLocale('en-US')
  try {
    await flushPromises()
    expectBoth(ui, enUS[key], indicator)
    expect(ui.get('.statusbar-network .statusbar-fact-label').text()).toBe(enUS['footer.account'])
  } finally {
    setLocale('zh-CN')
    await flushPromises()
  }
}

function publicButton(ui: VueWrapper, label: string) {
  const button = ui.findAll('button').find((entry) => entry.text() === label)
  if (!button) throw new Error(`Missing public button ${label}`)
  return button
}

describe('shared account session presentation (component diagnostics)', () => {
  it('keeps restoration, login, logout and session expiry consistent through public controls', async () => {
    let finish!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue({ ok: true, data: user })
    const logout = vi.fn<P2PManagementApi['logout']>().mockResolvedValue({
      ok: true,
      data: undefined
    })
    const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({ ok: true, data: user })
    const { ui, domain } = await render({ currentUser, logout, login })

    expectBoth(ui, zhCN['p2p.accountSession.restoring'], 'unknown')
    await expectEnglish(ui, 'p2p.accountSession.restoring', 'unknown')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    finish({ ok: true, data: user })
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
    await expectEnglish(ui, 'p2p.accountSession.signedIn', 'online')
    expect(ui.get('.p2p-account-identity-name').text()).toBe(user.username)

    await publicButton(ui, zhCN['p2p.account.logout']).trigger('click')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedOut'], 'offline')
    await expectEnglish(ui, 'p2p.accountSession.signedOut', 'offline')
    expect(domain.p2pAccounts.state(serviceId).user).toBeNull()
    expect(logout).toHaveBeenCalledWith(expect.objectContaining({ serviceId }))

    await ui.get('[data-testid="p2p-login-form"] input[type="email"]').setValue(user.username)
    await ui
      .get('[data-testid="p2p-login-form"] input[type="password"]')
      .setValue('test-only-password')
    await ui.get('[data-testid="p2p-login-form"]').trigger('submit')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId,
        username: user.username,
        password: 'test-only-password'
      })
    )
    expect(JSON.stringify(domain.p2pAccounts.state(serviceId))).not.toContain('test-only-password')

    currentUser.mockResolvedValueOnce({
      ok: false,
      code: 'p2p.user_session_expired',
      message: 'expired'
    })
    await ui.get('[data-testid="p2p-account-read-user"]').trigger('click')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedOut'], 'offline')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
  })

  it('does not turn an online device transport into a signed-in account', async () => {
    const { ui, domain } = await render({
      currentUser: vi.fn<P2PManagementApi['currentUser']>().mockResolvedValue({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'no selected session'
      }),
      serviceSessions: vi.fn<P2PManagementApi['serviceSessions']>().mockResolvedValue({
        ok: true,
        data: [{ serviceId, state: 'online', code: '' }]
      })
    })
    await domain.p2pNetwork.read()
    await flushPromises()

    expect(domain.p2pNetwork.isOnline(serviceId)).toBe(true)
    expectBoth(ui, zhCN['p2p.accountSession.signedOut'], 'offline')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
  })

  it('preserves the confirmed identity while both surfaces report an unconfirmed current read', async () => {
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValue({ ok: true, data: user })
    const { ui, domain } = await render({ currentUser })
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
    currentUser.mockResolvedValueOnce({
      ok: false,
      code: 'p2p.helper_resource_unavailable',
      message: 'core unavailable'
    })

    await ui.get('[data-testid="p2p-account-read-user"]').trigger('click')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.unknown'], 'unknown')
    await expectEnglish(ui, 'p2p.accountSession.unknown', 'unknown')
    expect(domain.p2pAccounts.state(serviceId).user).toEqual(user)
    expect(ui.get('.p2p-account-identity-name').text()).toBe(user.username)
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    expect(ui.get('[data-testid="p2p-network-create-open"]').attributes('disabled')).toBeDefined()

    await ui.get('[data-testid="p2p-account-read-user"]').trigger('click')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
  })

  it('follows only the selected service while another account read completes', async () => {
    let finishOther!: (value: Awaited<ReturnType<P2PManagementApi['currentUser']>>) => void
    const currentUser = vi.fn<P2PManagementApi['currentUser']>().mockImplementation((request) => {
      if (request.serviceId === serviceId) return Promise.resolve({ ok: true, data: user })
      return new Promise((resolve) => (finishOther = resolve))
    })
    const { ui, domain } = await render({ currentUser })
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
    domain.p2pManagement.selectedServiceId.value = otherServiceId
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.restoring'], 'unknown')

    await domain.p2pAccounts.currentUser(serviceId)
    await flushPromises()
    expect(domain.p2pAccounts.state(serviceId).user).toEqual(user)
    expectBoth(ui, zhCN['p2p.accountSession.restoring'], 'unknown')
    finishOther({ ok: false, code: 'p2p.user_login_required', message: 'other service signed out' })
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedOut'], 'offline')
    expect(domain.p2pAccounts.state(serviceId).user).toEqual(user)

    domain.p2pManagement.selectedServiceId.value = serviceId
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
    expect(ui.get('.p2p-account-identity-name').text()).toBe(user.username)
    expect(currentUser.mock.calls.map(([request]) => request.serviceId)).toContain(otherServiceId)
  })

  it('offers refresh rather than credentials when a signed-out cache becomes unconfirmed', async () => {
    let notify!: () => void
    const currentUser = vi
      .fn<P2PManagementApi['currentUser']>()
      .mockResolvedValueOnce({ ok: false, code: 'p2p.user_login_required', message: 'absent' })
      .mockResolvedValueOnce({
        ok: false,
        code: 'p2p.helper_resource_unavailable',
        message: 'temporary read failure'
      })
      .mockResolvedValue({ ok: true, data: user })
    const { ui, domain } = await render({
      currentUser,
      onServiceSessionsChange: (listener) => {
        notify = listener
        return () => undefined
      }
    })
    expectBoth(ui, zhCN['p2p.accountSession.signedOut'], 'offline')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(true)
    notify()
    await flushPromises()
    expect(domain.p2pAccounts.state(serviceId).user).toBeNull()
    expectBoth(ui, zhCN['p2p.accountSession.unknown'], 'unknown')
    expect(ui.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    await ui.get('[data-testid="p2p-account-read-user"]').trigger('click')
    await flushPromises()
    expectBoth(ui, zhCN['p2p.accountSession.signedIn'], 'online')
  })

  it('wires the actual AppShell account status to the shared adapter', () => {
    const appShell = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../AppShell.vue'),
      'utf8'
    )
    expect(appShell).toContain("import { useP2PAccountSession } from './useP2PAccountSession'")
    expect(appShell).toMatch(/useP2PAccountSession\(\s*p2pManagement\.selectedServiceId\s*\)/)
    expect(appShell).toContain(':network-value="shell.t(accountStatusKey)"')
    expect(appShell).toContain(':network-state="accountIndicator"')
    expect(appShell).not.toContain('p2pNetwork.isOnline(')
  })
})
