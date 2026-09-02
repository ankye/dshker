import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CopyPathButton from '../controls/CopyPathButton.vue'

/**
 * Registered paths and root IDs are shown so they can be pasted elsewhere, so
 * copying must succeed without hand-selecting a long monospace string, and a
 * clipboard the platform denies must not break the surface that renders it.
 */
describe('CopyPathButton', () => {
  it('writes the exact value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const wrapper = mount(CopyPathButton, { props: { value: '/tmp/harness' } })
    await wrapper.get('button').trigger('click')

    expect(writeText).toHaveBeenCalledWith('/tmp/harness')
    vi.unstubAllGlobals()
  })

  it('confirms the copy so the click is not silent', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })

    const wrapper = mount(CopyPathButton, { props: { value: '/tmp/harness' } })
    expect(wrapper.get('button').attributes('data-copied')).toBe('false')

    await wrapper.get('button').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.get('button').attributes('data-copied')).toBe('true')
    vi.unstubAllGlobals()
  })

  it('survives a denied clipboard without surfacing an error', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })

    const wrapper = mount(CopyPathButton, { props: { value: '/tmp/harness' } })
    await expect(wrapper.get('button').trigger('click')).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.get('button').attributes('data-copied')).toBe('false')
    vi.unstubAllGlobals()
  })
})
