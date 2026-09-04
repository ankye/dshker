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
