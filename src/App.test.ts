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

  it('reports the desktop bridge as unavailable when no preload bridge exists', async () => {
    const wrapper = mount(App)
    await flushPromises()

    // Without a preload bridge the shell must show an explicit unavailable
    // footer state rather than presenting a usable runtime.
    expect(wrapper.text()).toContain('Desktop API')
    expect(wrapper.text()).toContain('unavailable')
  })
})
