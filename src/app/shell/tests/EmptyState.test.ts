import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmptyState from '../components/EmptyState.vue'

/**
 * The point of this component is that a non-populated surface stays actionable
 * and consistent. These tests pin the parts that regressed before it existed:
 * routes each grew a private empty style, and a blocked state reported a problem
 * without offering any way out of it.
 */
describe('EmptyState', () => {
  it('renders the shared contract rather than a route-private structure', () => {
    const wrapper = mount(EmptyState, {
      props: { icon: 'inbox', title: 'Nothing here', description: 'Some detail.' }
    })

    const root = wrapper.get('.empty-state')
    expect(root.find('.empty-state-icon').exists()).toBe(true)
    expect(root.get('.empty-state-title').text()).toBe('Nothing here')
    expect(root.get('.empty-state-description').text()).toBe('Some detail.')
  })

  it('omits the description element when no description is supplied', () => {
    const wrapper = mount(EmptyState, { props: { icon: 'inbox', title: 'Nothing here' } })

    expect(wrapper.find('.empty-state-description').exists()).toBe(false)
  })

  it('exposes actions so a blocked state offers a way forward', () => {
    const wrapper = mount(EmptyState, {
      props: { icon: 'alert', title: 'Blocked', tone: 'danger' },
      slots: { actions: '<button type="button">Retry</button>' }
    })

    expect(wrapper.get('.empty-state-actions').find('button').text()).toBe('Retry')
  })

  it('announces a danger tone as an alert and other tones as status', () => {
    const danger = mount(EmptyState, {
      props: { icon: 'alert', title: 'Blocked', tone: 'danger' }
    })
    const neutral = mount(EmptyState, { props: { icon: 'inbox', title: 'Empty' } })

    expect(danger.get('.empty-state').attributes('role')).toBe('alert')
    expect(neutral.get('.empty-state').attributes('role')).toBe('status')
  })

  it('claims the route area only when asked, so populated states do not reflow', () => {
    const filled = mount(EmptyState, { props: { icon: 'plug', title: 'Idle', fill: true } })
    const inline = mount(EmptyState, { props: { icon: 'plug', title: 'Idle' } })

    expect(filled.get('.empty-state').attributes('data-fill')).toBe('true')
    expect(inline.get('.empty-state').attributes('data-fill')).toBe('false')
  })
})
