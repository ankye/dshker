import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi } from '@/shared/p2p-management'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'

const serviceId = 'a'.repeat(12)
const email = 'original@example.test'
const code = 'b'.repeat(64)
const password = 'new-password-123'
let previous: DesktopApi | undefined
let ui: VueWrapper | undefined
beforeEach(() => {
  previous = window.dshLauncher
  vi.resetModules()
})
afterEach(() => {
  ui?.unmount()
  ui = undefined
  window.dshLauncher = previous
  vi.restoreAllMocks()
})

async function render(resetPassword: P2PManagementApi['resetPassword']) {
  const login = vi.fn<P2PManagementApi['login']>().mockResolvedValue({
    ok: false,
    code: 'p2p.login_failed',
    message: 'rejected'
  })
  window.dshLauncher = {
    p2pManagement: {
      currentUser: async () => ({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'signed out'
      }),
      refreshDirectory: async () => ({
        ok: false,
        code: 'p2p.user_login_required',
        message: 'signed out'
      }),
      resetPassword,
      login
    }
  } as unknown as DesktopApi
  const panel = (await import('../components/P2PAccountPanel.vue')).default
  ui = mount(panel, { props: { serviceId, displayName: 'Pinned coordinator' } })
  await flushPromises()
  await ui.get('[data-testid="p2p-login-form"] input[autocomplete="username"]').setValue(email)
  await ui.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
  await ui.get('[data-testid="p2p-reset-code"]').setValue(code)
  await ui.get('[data-testid="p2p-reset-password"]').setValue(password)
  await ui.get('[data-testid="p2p-reset-confirm"]').setValue(password)
  await ui.get('[data-testid="p2p-password-reset-form"]').trigger('submit')
  await flushPromises()
  return { ui, login }
}

describe('password reset through the account panel and typed bridge', () => {
  it('publishes confirmed success and keeps the original login name without automatically signing in', async () => {
    const resetPassword = vi.fn<P2PManagementApi['resetPassword']>().mockResolvedValue({
      ok: true,
      data: undefined
    })
    const f = await render(resetPassword)
    expect(resetPassword).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      requestId: expect.any(Number),
      serviceId,
      email,
      code,
      password
    })
    expect(f.ui.get('[data-testid="p2p-reset-success"]').text()).toBe(
      zhCN['p2p.account.resetSucceeded']
    )
    expect(f.ui.find('[data-testid="p2p-password-reset-form"]').exists()).toBe(false)
    expect(
      (
        f.ui.get('[data-testid="p2p-login-form"] input[autocomplete="username"]')
          .element as HTMLInputElement
      ).value
    ).toBe(email)
    expect(f.login).not.toHaveBeenCalled()
  })

  it('shows the exact invalid-code explanation and requires freshly entered secrets for a retry', async () => {
    const resetPassword = vi.fn<P2PManagementApi['resetPassword']>().mockResolvedValue({
      ok: false,
      code: 'p2p.password_reset_invalid',
      message: 'rejected'
    })
    const f = await render(resetPassword)
    expect(f.ui.get('[data-testid="p2p-account-error"]').text()).toContain(
      zhCN['p2p.account.resetInvalid']
    )
    expect(f.ui.find('[data-testid="p2p-reset-success"]').exists()).toBe(false)
    expect((f.ui.get('[data-testid="p2p-reset-code"]').element as HTMLInputElement).value).toBe('')
    expect(f.ui.get('[data-testid="p2p-reset-submit"]').attributes('disabled')).toBeDefined()
    expect(f.login).not.toHaveBeenCalled()
  })

  it('keeps an unconfirmed reset blocked and offers manual new-password sign-in without resubmission', async () => {
    const resetPassword = vi
      .fn<P2PManagementApi['resetPassword']>()
      .mockRejectedValue(new Error('test-only reply loss'))
    const f = await render(resetPassword)
    expect(f.ui.get('[data-testid="p2p-account-error"]').text()).toContain(
      zhCN['p2p.account.resetUnconfirmed']
    )
    expect(f.ui.find('[data-testid="p2p-reset-success"]').exists()).toBe(false)
    expect(
      f.ui.get('[data-testid="p2p-password-reset-form"] fieldset').attributes('disabled')
    ).toBeDefined()
    await f.ui.get('[data-testid="p2p-account-switch-login"]').trigger('click')
    expect(
      f.ui.get('[data-testid="p2p-login-form"] fieldset').attributes('disabled')
    ).toBeUndefined()
    await f.ui.get('[data-testid="p2p-login-form"] input[type="password"]').setValue(password)
    await f.ui.get('[data-testid="p2p-login-form"]').trigger('submit')
    await flushPromises()
    expect(f.login).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      requestId: expect.any(Number),
      serviceId,
      username: email,
      password
    })
    expect(resetPassword).toHaveBeenCalledTimes(1)
  })

  it('explains failed protected cleanup and permits manual new-password login without resubmitting recovery', async () => {
    const resetPassword = vi.fn<P2PManagementApi['resetPassword']>().mockResolvedValue({
      ok: false,
      code: 'p2p.secret_delete_failed',
      message: 'p2p.secret_delete_failed'
    })
    const f = await render(resetPassword)
    expect(f.ui.get('[data-testid="p2p-account-error"]').text()).toContain(
      zhCN['p2p.refusal.secretDeleteFailed']
    )
    expect(f.ui.find('[data-testid="p2p-reset-success"]').exists()).toBe(false)
    expect(
      f.ui.get('[data-testid="p2p-password-reset-form"] fieldset').attributes('disabled')
    ).toBeDefined()
    await f.ui.get('[data-testid="p2p-account-switch-login"]').trigger('click')
    expect(
      f.ui.get('[data-testid="p2p-login-form"] fieldset').attributes('disabled')
    ).toBeUndefined()
    expect(resetPassword).toHaveBeenCalledTimes(1)
    expect(f.login).not.toHaveBeenCalled()
  })
})
