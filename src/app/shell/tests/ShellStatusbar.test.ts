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
    scopeValue: 'App start'
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
})
