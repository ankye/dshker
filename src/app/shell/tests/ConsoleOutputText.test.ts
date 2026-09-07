import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ConsoleOutputText from '../components/ConsoleOutputText.vue'

describe('ConsoleOutputText', () => {
  const entry = { text: 'Error: failed\n', stream: 'stderr' as const, seq: 1, occurredAt: 1000 }

  it('replaces stale severity when the entry changes', async () => {
    const wrapper = mount(ConsoleOutputText, { props: { entry } })
    expect(wrapper.get('span').attributes('data-severity')).toBe('error')
    await wrapper.setProps({ entry: { ...entry, seq: 2, text: '[I] recovered\n' } })
    expect(wrapper.get('span').attributes('data-severity')).toBe('normal')
    expect(wrapper.get('pre').element.textContent).toBe('[I] recovered\n')
  })

  it('renders log content only as text and preserves whitespace', () => {
    const text = '[I] <img src=x onerror=alert(1)>\n  indented\r\n\n'
    const wrapper = mount(ConsoleOutputText, { props: { entry: { ...entry, text } } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('pre').element.textContent).toBe(text)
  })

  it('keeps repeated input unchanged and clears all lines on reset', async () => {
    const wrapper = mount(ConsoleOutputText, { props: { entry } })
    const initial = wrapper.html()
    await wrapper.setProps({ entry: { ...entry } })
    expect(wrapper.html()).toBe(initial)
    await wrapper.setProps({ entry: { ...entry, seq: 2, text: '' } })
    expect(wrapper.findAll('.console-output-line')).toHaveLength(0)
    expect(wrapper.get('pre').element.textContent).toBe('')
  })
})
