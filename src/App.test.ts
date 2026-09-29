import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import App from './App.vue'

describe('DSHKer Launcher shell', () => {
  it('renders the operational shell without inheriting template sample content', async () => {
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('DSHKer Launcher')
    expect(wrapper.text()).not.toContain('Atlas paintover set')
  })

  it('keeps the footer focused on product state when no preload bridge exists', async () => {
    const wrapper = mount(App)
    await flushPromises()

    // The footer reports four product/runtime facts, not internal IPC details.
    const facts = wrapper.findAll('.statusbar-fact')
    expect(facts).toHaveLength(4)
    expect(facts.map((fact) => fact.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('DSHKer'), expect.stringContaining('DSH')])
    )
    expect(wrapper.text()).not.toContain('Desktop API')
  })
})
