import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'
import { harnessConsole } from '@/app/domains/launcher-harness'
import { useConsoleDrawer } from '../consoleDrawerState'
import ConsoleDrawer from '../components/ConsoleDrawer.vue'

/**
 * The drawer is a read-only tail: it must show the newest output on every
 * route, hand off to the full Console route, and never trap keyboard focus.
 */
describe('ConsoleDrawer', () => {
  const drawer = useConsoleDrawer()

  function entry(seq: number, stream: LauncherHarnessConsoleEntry['stream'] = 'launcher') {
    return { stream, occurredAt: 1_700_000_000_000 + seq, text: `line ${seq}\n`, seq }
  }

  afterEach(async () => {
    harnessConsole.value = []
    drawer.closeConsoleDrawer()
    await nextTick()
  })

  it('renders nothing while collapsed', () => {
    const wrapper = mount(ConsoleDrawer)

    expect(wrapper.find('.console-drawer').exists()).toBe(false)
  })

  it('renders the newest tail entries as a live log', async () => {
    harnessConsole.value = [entry(1), entry(2, 'stdout')]
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    const wrapper = mount(ConsoleDrawer)

    const log = wrapper.get('.console-drawer')
    expect(log.attributes('role')).toBe('log')
    const rows = wrapper.findAll('.console-drawer-entries li')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.attributes('data-stream')).toBe('stdout')
    expect(rows[1]?.text()).toContain('line 2')
  })

  it('keeps only the newest slice of a long feed', async () => {
    harnessConsole.value = Array.from({ length: 205 }, (_unused, index) => entry(index + 1))
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    const wrapper = mount(ConsoleDrawer)

    const rows = wrapper.findAll('.console-drawer-entries li')
    expect(rows).toHaveLength(200)
    expect(rows[0]?.text()).toContain('line 6')
    expect(rows[199]?.text()).toContain('line 205')
  })

  it('shares per-line severity and preserves stderr metadata', async () => {
    const text = '[I] watching\n[E] request failed\n[I] ready\n'
    harnessConsole.value = [{ ...entry(1, 'stderr'), text }]
    drawer.toggleConsoleDrawer()
    await nextTick()
    const wrapper = mount(ConsoleDrawer)
    expect(wrapper.get('.console-drawer-entries li').attributes('data-stream')).toBe('stderr')
    expect(
      wrapper.findAll('.console-output-line').map((line) => line.attributes('data-severity'))
    ).toEqual(['normal', 'error', 'normal'])
    expect(wrapper.get('.console-drawer-entries pre').element.textContent).toBe(text)
  })

  it('hands off to the Console route and collapses itself', async () => {
    harnessConsole.value = [entry(1)]
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    const wrapper = mount(ConsoleDrawer)

    await wrapper.get('.console-drawer-actions button').trigger('click')

    expect(wrapper.emitted('navigate')).toEqual([['controller']])
    expect(drawer.open.value).toBe(false)
  })

  /**
   * Opening the tail on an existing backlog used to land on the oldest retained
   * line: the list mounts at scrollTop 0 and only *appended* entries scrolled it,
   * so a user who opened the drawer after an operation finished had to scroll
   * down to find what just happened.
   *
   * happy-dom reports zero-height layout, so the scroll metrics are defined
   * explicitly; the assertion is that opening drives scrollTop to scrollHeight.
   */
  it('scrolls to the newest entry when opened on an existing backlog', async () => {
    harnessConsole.value = Array.from({ length: 120 }, (_unused, index) => entry(index + 1))
    await nextTick()
    const wrapper = mount(ConsoleDrawer)
    drawer.toggleConsoleDrawer()
    await nextTick()

    const list = wrapper.get('.console-drawer-entries').element as HTMLElement
    Object.defineProperty(list, 'scrollHeight', { value: 4000, configurable: true })
    list.scrollTop = 0

    // Re-open so the watcher runs against the now-measurable element.
    drawer.closeConsoleDrawer()
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    await nextTick()

    expect(list.scrollTop).toBe(4000)
    wrapper.unmount()
  })

  it('collapses on Escape without affecting other keys', async () => {
    harnessConsole.value = [entry(1)]
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    const wrapper = mount(ConsoleDrawer)

    await wrapper.get('.console-drawer').trigger('keydown', { key: 'Tab' })
    expect(drawer.open.value).toBe(true)

    await wrapper.get('.console-drawer').trigger('keydown', { key: 'Escape' })
    expect(drawer.open.value).toBe(false)
  })
})
