import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessConsole } from '@/app/domains/launcher-harness'
import { useConsoleDrawer } from '../consoleDrawerState'
import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'

/**
 * The drawer is the glance surface for output that arrives while the user works
 * elsewhere; the unread badge is its only closed-state voice, so its baseline,
 * sync, and toggle behavior are pinned here.
 */
describe('console drawer state', () => {
  const drawer = useConsoleDrawer()

  function entry(seq: number): LauncherHarnessConsoleEntry {
    return { stream: 'launcher', occurredAt: seq, text: `line ${seq}\n`, seq }
  }

  afterEach(async () => {
    harnessConsole.value = []
    drawer.closeConsoleDrawer()
    await nextTick()
    drawer.markConsoleSeen()
  })

  it('treats the startup feed as seen after the explicit baseline', async () => {
    harnessConsole.value = [entry(1), entry(2)]
    await nextTick()
    drawer.markConsoleSeen()

    expect(drawer.unread.value).toBe(false)
  })

  it('marks entries that arrive while the drawer is closed', async () => {
    harnessConsole.value = [entry(1)]
    await nextTick()
    drawer.markConsoleSeen()

    harnessConsole.value = [...harnessConsole.value, entry(2)]
    await nextTick()

    expect(drawer.unread.value).toBe(true)
  })

  it('clears the badge by opening, and keeps open arrivals seen', async () => {
    harnessConsole.value = [entry(1)]
    await nextTick()
    drawer.markConsoleSeen()
    harnessConsole.value = [...harnessConsole.value, entry(2)]
    await nextTick()

    drawer.toggleConsoleDrawer()
    await nextTick()
    expect(drawer.open.value).toBe(true)
    expect(drawer.unread.value).toBe(false)

    harnessConsole.value = [...harnessConsole.value, entry(3)]
    await nextTick()

    expect(drawer.unread.value).toBe(false)
  })

  it('marks the accumulated feed as unread again after closing unseen output', async () => {
    harnessConsole.value = [entry(1)]
    await nextTick()
    drawer.markConsoleSeen()
    harnessConsole.value = [...harnessConsole.value, entry(2)]
    await nextTick()
    drawer.toggleConsoleDrawer()
    await nextTick()
    drawer.closeConsoleDrawer()
    await nextTick()

    // Closing after having seen the feed leaves nothing unread.
    expect(drawer.unread.value).toBe(false)
  })
})
