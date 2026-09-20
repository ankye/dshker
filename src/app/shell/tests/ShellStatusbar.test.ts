import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ShellStatusbar from '../components/ShellStatusbar.vue'

/**
 * The statusbar is where a multi-minute switch either shows it is advancing or
 * looks frozen. These tests pin the determinate fill that makes step progress
 * visible without relying on animation (which reduced-motion preferences and
 * remote sessions routinely disable).
 */
describe('ShellStatusbar', () => {
  const base = {
    protocolLabel: 'Desktop API',
    protocolVersion: '1',
    scopeLabel: 'Scope',
    scopeValue: 'App start',
    networkLabel: 'Network',
    networkValue: 'Status unknown',
    networkState: 'unknown' as const,
    sidebarState: 'expanded' as const,
    collapseLabel: 'Collapse to icon rail',
    hideLabel: 'Hide',
    expandLabel: 'Expand',
    consoleLabel: 'Live output',
    consoleUnreadLabel: 'New output',
    consoleOpen: false,
    consoleUnread: false
  }

  it('slides indeterminately while no step progress exists', () => {
    const wrapper = mount(ShellStatusbar, {
      props: { ...base, operationLabel: '正在启动 DSH Web…' }
    })

    const bar = wrapper.get('.statusbar-progress-bar')
    // Vue renders the explicit false; the CSS only matches the determinate value.
    expect(bar.attributes('data-determinate')).toBe('false')
    expect(bar.attributes('style')).toBeUndefined()
    expect(wrapper.get('.statusbar-progress-text').text()).toBe('正在启动 DSH Web…')
  })

  it('states network reach on every route, distinguishing unread from offline', async () => {
    // Network reach governs whether any remote workbench can open, so it belongs
    // to the shell rather than to the Connect tab that used to own it alone.
    const unknown = mount(ShellStatusbar, { props: base })
    expect(unknown.get('.statusbar-network').attributes('data-state')).toBe('unknown')

    const offline = mount(ShellStatusbar, {
      props: { ...base, networkValue: 'Offline', networkState: 'offline' as const }
    })
    expect(offline.get('.statusbar-network').attributes('data-state')).toBe('offline')
    expect(offline.get('.statusbar-network').text()).toContain('Offline')

    const online = mount(ShellStatusbar, {
      props: { ...base, networkValue: 'Online', networkState: 'online' as const }
    })
    expect(online.get('.statusbar-network').attributes('data-state')).toBe('online')
  })

  it('reveals the console tail when the busy strip is activated', async () => {
    const wrapper = mount(ShellStatusbar, {
      props: { ...base, operationLabel: 'busy' }
    })

    await wrapper.get('.statusbar-progress').trigger('click')

    expect(wrapper.emitted('progressToggle')).toEqual([[]])
  })

  it('fills determinately from step progress instead of animating', () => {
    const wrapper = mount(ShellStatusbar, {
      props: {
        ...base,
        operationLabel: '正在切换内核并安装依赖… · 步骤 3/7 · 42s',
        operationProgress: 3 / 7
      }
    })

    const bar = wrapper.get('.statusbar-progress-bar')
    expect(bar.attributes('data-determinate')).toBe('true')
    expect(bar.attributes('style')).toContain('width: 43%')
  })

  it('clamps an out-of-range ratio into the track', () => {
    const wrapper = mount(ShellStatusbar, {
      props: { ...base, operationLabel: 'busy', operationProgress: 1.5 }
    })

    expect(wrapper.get('.statusbar-progress-bar').attributes('style')).toContain('width: 100%')
  })

  it('shows protocol facts when idle', () => {
    const wrapper = mount(ShellStatusbar, { props: base })

    expect(wrapper.find('.statusbar-progress').exists()).toBe(false)
    expect(wrapper.text()).toContain('Desktop API · 1')
  })

  it('leads with the sidebar and console controls it took over from the rail', async () => {
    const wrapper = mount(ShellStatusbar, { props: base })
    const controls = wrapper.get('.statusbar-controls')
    const buttons = controls.findAll('.statusbar-control')

    expect(buttons).toHaveLength(2)
    // The group is the bar's first child so the read-only facts stay trailing.
    expect(wrapper.get('.statusbar').element.firstElementChild).toBe(controls.element)
    for (const button of buttons) {
      expect(button.attributes('disabled')).toBeUndefined()
      expect(button.find('svg').exists()).toBe(true)
    }
    expect(wrapper.get('.statusbar-sidebar-toggle svg').attributes('data-icon')).toBe('menu')
    expect(wrapper.get('.statusbar-console-toggle svg').attributes('data-icon')).toBe(
      'command-line'
    )

    await wrapper.get('.statusbar-sidebar-toggle').trigger('click')
    expect(wrapper.emitted('advanceSidebar')).toEqual([[]])

    await wrapper.get('.statusbar-console-toggle').trigger('click')
    expect(wrapper.emitted('toggleConsole')).toEqual([[]])
  })

  it('states the sidebar control next action for every sidebar state', async () => {
    const wrapper = mount(ShellStatusbar, { props: base })
    const toggle = () => wrapper.get('.statusbar-sidebar-toggle')

    expect(toggle().attributes('aria-label')).toBe('Collapse to icon rail')
    await wrapper.setProps({ sidebarState: 'collapsed' as const })
    expect(toggle().attributes('aria-label')).toBe('Hide')
    await wrapper.setProps({ sidebarState: 'hidden' as const })
    expect(toggle().attributes('aria-label')).toBe('Expand')
  })

  it('advertises unread console output and the tail expanded state', async () => {
    const wrapper = mount(ShellStatusbar, { props: base })

    expect(wrapper.get('.statusbar-console-toggle').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.statusbar-console-toggle').attributes('aria-label')).toBe('Live output')
    expect(wrapper.find('.statusbar-console-badge').exists()).toBe(false)

    await wrapper.setProps({ consoleUnread: true, consoleOpen: true })
    expect(wrapper.get('.statusbar-console-toggle').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.statusbar-console-toggle').attributes('aria-label')).toBe(
      'Live output · New output'
    )
    expect(wrapper.find('.statusbar-console-badge').exists()).toBe(true)
  })

  it('keeps both controls usable while the busy strip runs', async () => {
    // A long switch must not take navigation chrome away from the user, which is
    // why the control group sits outside the busy/idle branch.
    const wrapper = mount(ShellStatusbar, {
      props: { ...base, operationLabel: 'busy', operationProgress: 0.5 }
    })

    expect(wrapper.findAll('.statusbar-control')).toHaveLength(2)
    expect(wrapper.find('.statusbar-progress').exists()).toBe(true)

    await wrapper.get('.statusbar-sidebar-toggle').trigger('click')
    expect(wrapper.emitted('advanceSidebar')).toEqual([[]])
  })
})
