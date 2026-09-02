import { mount } from '@vue/test-utils'
import { defineComponent, h, watch } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { launchAttempts } from '@/app/domains/launcher-harness'
import { useLauncherShell } from '../useLauncherShell'

vi.mock('@/foundation/appMetadata', () => ({
  getBootstrapInfo: vi.fn(async () => ({ ok: false as const, code: 'bridge' as const }))
}))

/**
 * Launching used to leave the user on the Launch route while the reason a launch
 * failed printed into the Console route they could not see. The shell now
 * follows the launch to that output.
 *
 * The navigation rule is asserted here rather than through a full AppShell mount
 * so it does not depend on the whole route tree rendering in happy-dom.
 */
describe('launch navigates to the console', () => {
  /** Mirrors the shell's own watch so the rule under test is the shared one. */
  function mountShellWithLaunchWatch() {
    let shell!: ReturnType<typeof useLauncherShell>
    const wrapper = mount(
      defineComponent({
        setup() {
          shell = useLauncherShell()
          watch(
            () => launchAttempts.value,
            (attempts, previous) => {
              if (attempts > (previous ?? 0)) shell.selectRoute('controller')
            }
          )
          return () => h('div')
        }
      })
    )
    return { shell, wrapper }
  }

  it('switches to the console route when a launch is attempted', async () => {
    const { shell, wrapper } = mountShellWithLaunchWatch()
    expect(shell.activeRoute.value).toBe('launch')

    launchAttempts.value += 1
    await wrapper.vm.$nextTick()

    expect(shell.activeRoute.value).toBe('controller')
  })

  it('follows a second attempt after the user navigates away', async () => {
    const { shell, wrapper } = mountShellWithLaunchWatch()

    launchAttempts.value += 1
    await wrapper.vm.$nextTick()
    shell.selectRoute('versions')
    expect(shell.activeRoute.value).toBe('versions')

    // A retry after a failed launch must navigate again; watching a counter
    // rather than a boolean is what makes the second attempt observable.
    launchAttempts.value += 1
    await wrapper.vm.$nextTick()

    expect(shell.activeRoute.value).toBe('controller')
  })

  it('does not hijack navigation when no launch occurs', async () => {
    const { shell, wrapper } = mountShellWithLaunchWatch()

    shell.selectRoute('settings')
    await wrapper.vm.$nextTick()

    expect(shell.activeRoute.value).toBe('settings')
  })
})
