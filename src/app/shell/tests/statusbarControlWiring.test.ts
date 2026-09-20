import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineComponent, h, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { SidebarState } from '../useLauncherShell'
import ShellStatusbar from '../components/ShellStatusbar.vue'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const appShell = readFileSync(path.join(appRoot, 'src/app/shell/AppShell.vue'), 'utf8')
const sidebar = readFileSync(
  path.join(appRoot, 'src/app/shell/components/ShellSidebar.vue'),
  'utf8'
)

/**
 * The two shell chrome controls were moved from the sidebar's floating rail into
 * the status bar, which renamed the sidebar-cycle event and changed its host
 * component. Component tests assert the child emits, and `sidebarState.test.ts`
 * asserts the cycle function, but neither covers the line between them.
 *
 * That gap is not theoretical: a misspelled or stale `@advance-sidebar` listener
 * in `AppShell.vue` leaves the button inert while `vue-tsc`, the whole test
 * suite, and `visual:smoke` all stay green, because Vue template listener names
 * are not type-checked. This mounts the real ShellStatusbar against the real
 * cycle and asserts a click actually advances the state.
 */
describe('statusbar chrome control wiring', () => {
  function mountStatusbarWithShellHandlers() {
    const sidebarState = ref<SidebarState>('expanded')
    const consoleOpen = ref(false)
    function advanceSidebar(): void {
      sidebarState.value =
        sidebarState.value === 'expanded'
          ? 'collapsed'
          : sidebarState.value === 'collapsed'
            ? 'hidden'
            : 'expanded'
    }
    const wrapper = mount(
      defineComponent({
        setup() {
          return () =>
            h(ShellStatusbar, {
              protocolLabel: 'Desktop API',
              protocolVersion: '1',
              scopeLabel: 'Scope',
              scopeValue: 'App start',
              networkLabel: 'Network',
              networkValue: 'Status unknown',
              networkState: 'unknown',
              sidebarState: sidebarState.value,
              collapseLabel: 'Collapse to icon rail',
              hideLabel: 'Hide sidebar',
              expandLabel: 'Expand sidebar',
              consoleLabel: 'Live output',
              consoleUnreadLabel: 'New output',
              consoleOpen: consoleOpen.value,
              consoleUnread: false,
              // The names below must stay identical to the AppShell template's
              // listeners; a rename on either side breaks this assertion.
              onAdvanceSidebar: advanceSidebar,
              onToggleConsole: () => {
                consoleOpen.value = !consoleOpen.value
              },
              onProgressToggle: () => {
                consoleOpen.value = !consoleOpen.value
              }
            })
        }
      })
    )
    return { wrapper, sidebarState, consoleOpen }
  }

  it('advances the real sidebar cycle when the status bar control is clicked', async () => {
    const { wrapper, sidebarState } = mountStatusbarWithShellHandlers()

    expect(sidebarState.value).toBe('expanded')
    await wrapper.get('.statusbar-sidebar-toggle').trigger('click')
    expect(sidebarState.value).toBe('collapsed')
    await wrapper.get('.statusbar-sidebar-toggle').trigger('click')
    expect(sidebarState.value).toBe('hidden')
    await wrapper.get('.statusbar-sidebar-toggle').trigger('click')
    expect(sidebarState.value).toBe('expanded')
  })

  it('toggles the console tail from the status bar control', async () => {
    const { wrapper, consoleOpen } = mountStatusbarWithShellHandlers()

    await wrapper.get('.statusbar-console-toggle').trigger('click')
    expect(consoleOpen.value).toBe(true)
    await wrapper.get('.statusbar-console-toggle').trigger('click')
    expect(consoleOpen.value).toBe(false)
  })

  /**
   * The mounted assertions above prove the component contract. This one proves
   * AppShell actually subscribes to it: a stale `@advance` or a misspelled
   * listener name is invisible to `vue-tsc`, so the template text is the only
   * place that mistake can be caught.
   */
  it('subscribes AppShell to both controls and keeps them off the sidebar', () => {
    expect(appShell).toContain('@advance-sidebar="shell.advanceSidebar"')
    expect(appShell).toContain('@toggle-console="consoleDrawer.toggleConsoleDrawer"')
    expect(appShell).toContain('@progress-toggle="consoleDrawer.toggleConsoleDrawer"')
    expect(appShell).toContain(':sidebar-state="shell.sidebarState.value"')
    // The sidebar must not regain the controls or the labels they need.
    expect(sidebar).not.toContain('sidebar-toggle')
    expect(sidebar).not.toContain('toggleConsole')
    expect(appShell).not.toContain('@advance="shell.advanceSidebar"')
  })
})
