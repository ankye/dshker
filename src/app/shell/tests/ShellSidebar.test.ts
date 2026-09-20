import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { APPLICATION_ROUTES } from '../../shared/navigation/routes'
import ShellSidebar from '../components/ShellSidebar.vue'

const items = APPLICATION_ROUTES.map((route) => ({
  id: route.id,
  label: route.labelKey,
  icon: route.icon
}))

function mountSidebar() {
  return mount(ShellSidebar, {
    props: {
      items,
      activeRoute: 'launch',
      state: 'expanded',
      title: 'DSHKer Launcher'
    }
  })
}

describe('ShellSidebar', () => {
  afterEach(() => {
    document.head.querySelectorAll('[data-sidebar-layout-test]').forEach((node) => node.remove())
    document.body.innerHTML = ''
  })

  it('carries no floating control rail in any state', async () => {
    // Both shell controls moved to the status bar, so the sidebar must not
    // reintroduce chrome that floats over the route plane or the Run guest.
    const sheet = document.createElement('style')
    sheet.dataset.sidebarLayoutTest = 'true'
    sheet.textContent = readFileSync('src/styles/base-shell.css', 'utf8')
    document.head.append(sheet)
    const shell = document.createElement('div')
    shell.className = 'shell-body'
    document.body.append(shell)
    const wrapper = mountSidebar()
    shell.append(wrapper.element)

    for (const state of ['expanded', 'collapsed', 'hidden', 'expanded'] as const) {
      shell.dataset.sidebarState = state
      await wrapper.setProps({ state })
      expect(wrapper.findAll('.sidebar-toggle')).toHaveLength(0)
      expect(wrapper.find('.sidebar-console-badge').exists()).toBe(false)
      const region = wrapper.get('.sidebar-region').element
      // A hidden sidebar leaves the layout entirely instead of becoming a
      // pointer-transparent overlay that used to host the rail.
      expect(getComputedStyle(region).display).toBe(state === 'hidden' ? 'none' : 'block')
    }
    wrapper.unmount()
  })

  it('renders an inline SVG icon for every navigation entry', () => {
    const wrapper = mountSidebar()
    const navItems = wrapper.findAll('[data-testid^="nav-"]')

    expect(navItems).toHaveLength(APPLICATION_ROUTES.length)
    for (const navItem of navItems) {
      expect(navItem.find('svg.route-icon').exists()).toBe(true)
      expect(navItem.find('svg.route-icon').attributes('aria-hidden')).toBe('true')
    }
  })

  it('emits select with the route id when an entry is activated', async () => {
    const wrapper = mountSidebar()
    await wrapper.find('[data-testid="nav-settings"]').trigger('click')

    expect(wrapper.emitted('select')).toEqual([['settings']])
  })

  it('keeps every destination reachable when collapsed and renders nothing when hidden', async () => {
    const wrapper = mountSidebar()

    await wrapper.setProps({ state: 'collapsed' })
    expect(wrapper.find('.sidebar').attributes('data-collapsed')).toBe('true')
    expect(wrapper.findAll('[data-testid^="nav-"]')).toHaveLength(APPLICATION_ROUTES.length)

    await wrapper.setProps({ state: 'hidden' })
    expect(wrapper.find('.sidebar').exists()).toBe(false)
  })
})
