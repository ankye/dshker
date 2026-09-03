import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useLauncherShell } from '../useLauncherShell'

vi.mock('@/foundation/appMetadata', () => ({
  getBootstrapInfo: vi.fn(async () => ({ ok: false as const, code: 'bridge' as const }))
}))

/** Verifies the visible sidebar states cycle without leaving the restore control stranded. */
describe('sidebar presentation state', () => {
  it('cycles expanded, collapsed, hidden, and expanded', () => {
    let shell!: ReturnType<typeof useLauncherShell>
    mount(
      defineComponent({
        setup() {
          shell = useLauncherShell()
          return () => h('div')
        }
      })
    )

    expect(shell.sidebarState.value).toBe('expanded')
    shell.advanceSidebar()
    expect(shell.sidebarState.value).toBe('collapsed')
    shell.advanceSidebar()
    expect(shell.sidebarState.value).toBe('hidden')
    shell.advanceSidebar()
    expect(shell.sidebarState.value).toBe('expanded')
  })
})
