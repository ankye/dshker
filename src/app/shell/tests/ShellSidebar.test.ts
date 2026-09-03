import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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
      title: 'DSHKer Launcher',
      collapseLabel: 'Collapse to icon rail',
      hideLabel: 'Hide',
      expandLabel: 'Expand'
    }
  })
}

describe('ShellSidebar', () => {
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

  it('keeps the floating sidebar control accessible and advances the state cycle', async () => {
    const wrapper = mountSidebar()
    const toggle = wrapper.get('.sidebar-toggle')

    expect(toggle.attributes('aria-label')).toBe('Collapse to icon rail')
    expect(toggle.find('svg').exists()).toBe(true)
    await toggle.trigger('click')
    expect(wrapper.emitted('advance')).toEqual([[]])
  })

  it('exposes the next action when the sidebar is collapsed or hidden', async () => {
    const wrapper = mountSidebar()

    await wrapper.setProps({ state: 'collapsed' })
    expect(wrapper.get('.sidebar-toggle').attributes('aria-label')).toBe('Hide')
    expect(wrapper.find('.sidebar').attributes('data-collapsed')).toBe('true')

    await wrapper.setProps({ state: 'hidden' })
    expect(wrapper.get('.sidebar-toggle').attributes('aria-label')).toBe('Expand')
    expect(wrapper.find('.sidebar').exists()).toBe(false)
  })
})
