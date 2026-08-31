import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ThemedListbox from '../ThemedListbox.vue'

interface Harness {
  modelValue: string
  options: readonly { value: string; label: string; disabled?: boolean }[]
}

function mountListbox(overrides: Partial<Harness> = {}) {
  return mount(ThemedListbox, {
    props: {
      modelValue: overrides.modelValue ?? '',
      options: overrides.options ?? [
        { value: '', label: 'Placeholder', disabled: true },
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' }
      ],
      label: 'Example',
      testId: 'example'
    }
  })
}

describe('ThemedListbox', () => {
  it('exposes an explicit combobox contract instead of a native select', () => {
    const wrapper = mountListbox()
    const trigger = wrapper.get('[data-testid="example"]')

    expect(wrapper.find('select').exists()).toBe(false)
    expect(trigger.attributes('role')).toBe('combobox')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-label')).toBe('Example')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('commits a clicked option and closes the popup', async () => {
    const wrapper = mountListbox()

    await wrapper.get('[data-testid="example"]').trigger('click')
    expect(wrapper.get('[data-testid="example"]').attributes('aria-expanded')).toBe('true')

    const options = wrapper.findAll('[role="option"]')
    await options[2]?.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([['beta']])
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('traverses with arrow keys and skips a disabled option', async () => {
    const wrapper = mountListbox()

    await wrapper.get('[data-testid="example"]').trigger('keydown', { key: 'ArrowDown' })
    const list = wrapper.get('[role="listbox"]')

    // The active row starts on the selected placeholder, so one step must land
    // on 'Alpha' and never rest on the disabled placeholder again.
    await list.trigger('keydown', { key: 'ArrowDown' })
    await list.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toEqual([['alpha']])
  })

  it('reaches the last option with End and the first enabled option with Home', async () => {
    const wrapper = mountListbox()

    await wrapper.get('[data-testid="example"]').trigger('click')
    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'End' })
    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('update:modelValue')).toEqual([['beta']])

    const second = mountListbox()
    await second.get('[data-testid="example"]').trigger('click')
    await second.get('[role="listbox"]').trigger('keydown', { key: 'Home' })
    await second.get('[role="listbox"]').trigger('keydown', { key: 'Enter' })

    expect(second.emitted('update:modelValue')).toEqual([['alpha']])
  })

  it('dismisses on Escape without committing a value', async () => {
    const wrapper = mountListbox()

    await wrapper.get('[data-testid="example"]').trigger('click')
    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('[role="listbox"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })

  it('never commits a disabled option', async () => {
    const wrapper = mountListbox()

    await wrapper.get('[data-testid="example"]').trigger('click')
    await wrapper.findAll('[role="option"]')[0]?.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('cannot be opened when it is disabled or carries no option', async () => {
    const disabled = mount(ThemedListbox, {
      props: {
        modelValue: '',
        options: [{ value: 'alpha', label: 'Alpha' }],
        label: 'Example',
        testId: 'example',
        disabled: true
      }
    })
    await disabled.get('[data-testid="example"]').trigger('click')
    expect(disabled.find('[role="listbox"]').exists()).toBe(false)

    const empty = mountListbox({ options: [] })
    await empty.get('[data-testid="example"]').trigger('click')
    expect(empty.find('[role="listbox"]').exists()).toBe(false)
    expect(empty.get('[data-testid="example"]').attributes('disabled')).toBeDefined()
  })

  it('marks the selected option and shows its label on the trigger', async () => {
    const wrapper = mountListbox({ modelValue: 'beta' })

    expect(wrapper.get('[data-testid="example"]').text()).toContain('Beta')

    await wrapper.get('[data-testid="example"]').trigger('click')
    const selected = wrapper
      .findAll('[role="option"]')
      .filter((option) => option.attributes('aria-selected') === 'true')

    expect(selected).toHaveLength(1)
    expect(selected[0]?.text()).toBe('Beta')
  })
})
