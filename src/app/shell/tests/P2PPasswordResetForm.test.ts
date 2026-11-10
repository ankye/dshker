import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import P2PAccountAuthForm from '../components/P2PAccountAuthForm.vue'
import P2PPasswordResetForm from '../components/P2PPasswordResetForm.vue'
import { zhCN } from '@/app/shared/i18n/messages.zh-CN'

const code = 'a'.repeat(64)
const password = 'new-password-123'
let ui: VueWrapper | undefined
afterEach(() => {
  ui?.unmount()
  ui = undefined
})

function renderAuth(extra = {}) {
  ui = mount(P2PAccountAuthForm, {
    props: {
      serviceId: 'b'.repeat(12),
      username: 'original@example.test',
      busy: false,
      uncertain: false,
      resetCompleted: 0,
      ...extra
    }
  })
  return ui
}

async function fillReset(wrapper: VueWrapper, suppliedPassword = password) {
  await wrapper.get('[data-testid="p2p-reset-code"]').setValue(code)
  await wrapper.get('[data-testid="p2p-reset-password"]').setValue(suppliedPassword)
  await wrapper.get('[data-testid="p2p-reset-confirm"]').setValue(suppliedPassword)
}

describe('password recovery public form', () => {
  it('opens recovery from sign-in with an explicit administrator instruction', async () => {
    const wrapper = renderAuth()
    await wrapper.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
    expect(wrapper.find('[data-testid="p2p-login-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="p2p-register-form"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="p2p-password-reset-form"]').text()).toContain(
      zhCN['p2p.account.resetHint']
    )
    expect((wrapper.get('[data-testid="p2p-reset-email"]').element as HTMLInputElement).value).toBe(
      'original@example.test'
    )
    expect(wrapper.text()).not.toContain('邮件已发送')
  })

  it('requires exact code, confirmation, Unicode character minimum and UTF-8 byte maximum', async () => {
    ui = mount(P2PPasswordResetForm, {
      props: { username: 'original@example.test', disabled: false }
    })
    const submit = ui.get('[data-testid="p2p-reset-submit"]')
    await fillReset(ui)
    await ui.get('[data-testid="p2p-reset-code"]').setValue('a'.repeat(63))
    expect(submit.attributes('disabled')).toBeDefined()
    await ui.get('[data-testid="p2p-reset-code"]').setValue(code)
    await ui.get('[data-testid="p2p-reset-confirm"]').setValue('')
    expect(submit.attributes('disabled')).toBeDefined()
    await ui.get('[data-testid="p2p-reset-confirm"]').setValue('different-password')
    expect(ui.text()).toContain(zhCN['p2p.account.resetMismatch'])
    await fillReset(ui, '😀'.repeat(6))
    expect(submit.attributes('disabled')).toBeDefined()
    await fillReset(ui, '😀'.repeat(12))
    expect(submit.attributes('disabled')).toBeUndefined()
    await fillReset(ui, '界'.repeat(25))
    expect(submit.attributes('disabled')).toBeDefined()
    expect(ui.text()).toContain(zhCN['p2p.account.passwordTooLong'])
    await ui.trigger('submit')
    expect(ui.emitted('submit')).toBeUndefined()
  })

  it('submits once with the original email and clears every secret before publishing the event', async () => {
    const wrapper = renderAuth()
    await wrapper.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
    await fillReset(wrapper)
    await wrapper.get('[data-testid="p2p-password-reset-form"]').trigger('submit')
    expect(wrapper.emitted('resetPassword')).toEqual([['original@example.test', code, password]])
    for (const field of ['code', 'password', 'confirm'])
      expect(
        (wrapper.get(`[data-testid="p2p-reset-${field}"]`).element as HTMLInputElement).value
      ).toBe('')
    await wrapper.get('[data-testid="p2p-password-reset-form"]').trigger('submit')
    expect(wrapper.emitted('resetPassword')).toHaveLength(1)
    expect(wrapper.emitted('login')).toBeUndefined()
  })

  it('destroys abandoned secrets on switching forms and changing the service identity', async () => {
    const wrapper = renderAuth()
    await wrapper
      .get('[data-testid="p2p-login-form"] input[type="password"]')
      .setValue('old-secret')
    await wrapper.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
    await fillReset(wrapper)
    await wrapper.get('[data-testid="p2p-account-switch-login"]').trigger('click')
    expect(
      (
        wrapper.get('[data-testid="p2p-login-form"] input[type="password"]')
          .element as HTMLInputElement
      ).value
    ).toBe('')
    await wrapper.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
    expect((wrapper.get('[data-testid="p2p-reset-code"]').element as HTMLInputElement).value).toBe(
      ''
    )
    await fillReset(wrapper)
    await wrapper.setProps({ serviceId: 'c'.repeat(12) })
    for (const field of ['code', 'password', 'confirm'])
      expect(
        (wrapper.get(`[data-testid="p2p-reset-${field}"]`).element as HTMLInputElement).value
      ).toBe('')
  })

  it('shows confirmed success at sign-in and permits manual new-password login after an unknown result', async () => {
    const wrapper = renderAuth()
    await wrapper.get('[data-testid="p2p-account-switch-reset"]').trigger('click')
    await wrapper.setProps({ resetUnconfirmed: true })
    expect(
      wrapper.get('[data-testid="p2p-password-reset-form"] fieldset').attributes('disabled')
    ).toBeDefined()
    await wrapper.get('[data-testid="p2p-account-switch-login"]').trigger('click')
    expect(
      wrapper.get('[data-testid="p2p-login-form"] fieldset').attributes('disabled')
    ).toBeUndefined()
    await wrapper.get('[data-testid="p2p-login-form"] input[type="password"]').setValue(password)
    await wrapper.get('[data-testid="p2p-login-form"]').trigger('submit')
    expect(wrapper.emitted('login')).toEqual([['original@example.test', password]])
    await wrapper.setProps({ resetUnconfirmed: false, resetCompleted: 1 })
    await flushPromises()
    expect(wrapper.get('[data-testid="p2p-reset-success"]').text()).toBe(
      zhCN['p2p.account.resetSucceeded']
    )
    expect(wrapper.find('[data-testid="p2p-password-reset-form"]').exists()).toBe(false)
  })
})
