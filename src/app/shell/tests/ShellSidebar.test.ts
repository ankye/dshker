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
      collapsed: false,
      title: 'DSHKer Launcher',
      collapseLabel: 'Collapse',
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
})
