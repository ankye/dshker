import { mount } from '@vue/test-utils'
import { computed, defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPLICATION_ROUTES } from '../../shared/navigation/routes'
import { setLocale } from '../../shared/i18n/useLocale'
import { useLauncherShell } from '../useLauncherShell'

vi.mock('@/foundation/appMetadata', () => ({
  getBootstrapInfo: vi.fn(async () => ({ ok: false as const, code: 'bridge' as const }))
}))

/**
 * The shell owns the chrome every route renders inside: sidebar labels, the
 * topbar, toast copy, and the status bar. It regressed by binding its translator
 * to the bootstrap locale, which never re-evaluated — so switching language in
 * Settings translated route bodies while the whole frame stayed Chinese, and the
 * existing suite passed throughout.
 *
 * These tests assert the shell follows the active locale, not merely that some
 * translation happened, so the half-translated window cannot come back unnoticed.
 */
describe('shell locale reactivity', () => {
  afterEach(() => {
    setLocale('zh-CN')
  })

  /** Mounts the composable so its reactive scope behaves as it does in the app. */
  function mountShell() {
    let shell!: ReturnType<typeof useLauncherShell>
    const navLabels = computed(() => APPLICATION_ROUTES.map((route) => shell.t(route.labelKey)))
    const wrapper = mount(
      defineComponent({
        setup() {
          shell = useLauncherShell()
          return () => h('div', navLabels.value.join('|'))
        }
      })
    )
    return { shell, navLabels, wrapper }
  }

  it('translates navigation labels into the locale selected after mount', async () => {
    const { navLabels, wrapper } = mountShell()
    expect(navLabels.value).toContain('一键启动')

    setLocale('en-US')
    await wrapper.vm.$nextTick()

    expect(navLabels.value).toContain('Launch')
    expect(navLabels.value).not.toContain('一键启动')
  })

  it('re-renders navigation labels in the DOM rather than only in the computed', async () => {
    const { wrapper } = mountShell()
    expect(wrapper.text()).toContain('一键启动')

    setLocale('en-US')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Launch')
  })

  it('follows the locale for the status bar, which reads bootstrap state', async () => {
    const { shell, wrapper } = mountShell()
    // Awaited first: the mocked bootstrap settles to `blocked` on its own, and
    // asserting across that transition would compare two different states.
    await vi.waitFor(() => expect(shell.bootstrap.value.kind).toBe('blocked'))
    expect(shell.bootstrapStatus.value).toBe('配置尚未就绪')

    setLocale('en-US')
    await wrapper.vm.$nextTick()

    expect(shell.bootstrapStatus.value).toBe('Setup is not ready')
  })

  it('switches back, so the translator tracks the locale instead of latching once', async () => {
    const { shell, wrapper } = mountShell()

    setLocale('en-US')
    await wrapper.vm.$nextTick()
    expect(shell.t('nav.settings')).toBe('Settings')

    setLocale('zh-CN')
    await wrapper.vm.$nextTick()
    expect(shell.t('nav.launch')).toBe('一键启动')
  })
})
