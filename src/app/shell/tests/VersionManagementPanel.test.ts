import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import { apiFail, apiOk, type LauncherHarnessState } from '@/shared/contracts'
import VersionManagementPanel from '../components/VersionManagementPanel.vue'
import { versionView } from '../versionViewState'

const revision = 'a'.repeat(40)
const invalidCheckout = {
  kind: 'invalid',
  harnessDirectory: '/test/harness',
  message: 'Build failed.',
  remoteUrl: 'https://example.test/dsh.git',
  currentBranch: null,
  branches: ['master', 'feature'],
  revision,
  launch: { kind: 'stopped' },
  port: { mode: 'auto' },
  commits: [],
  stableVersions: [{ tag: 'v1.0.0', hash: revision, subject: 'Release', committedAt: 0 }],
  plugins: [],
  console: [],
  logFile: { path: '/test/logs/dsh-web.log', exists: false, byteLength: 0 }
} satisfies LauncherHarnessState

describe('core version management', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    versionView.branchPickerOpen.value = false
    harnessState.value = undefined
    vi.unstubAllGlobals()
  })

  async function renderPanel(state: LauncherHarnessState) {
    const switchVersion = vi.fn(async () => apiOk(state))
    const switchBranch = vi.fn(async () =>
      apiFail('managed.git_repository_dirty', 'The checkout has local changes.')
    )
    vi.stubGlobal('dshLauncher', {
      launcherHarness: { getState: async () => apiOk(state), switchVersion, switchBranch },
      pluginCatalog: {
        getState: async () => apiFail('managed.plugin_catalog_read_failed', 'Catalog empty.')
      }
    })
    const panel = mount(VersionManagementPanel)
    wrapper = panel
    await flushPromises()
    return { panel, switchVersion, switchBranch }
  }

  it('allows retrying the exact revision when the detached checkout failed to build', async () => {
    const { panel, switchVersion } = await renderPanel(invalidCheckout)

    expect(panel.get('.version-scope-row').text()).toContain('分离 HEAD')
    const retry = panel.get('button.version-switch-action')
    expect(retry.text()).toBe('重试构建')
    await retry.trigger('click')
    expect(switchVersion).toHaveBeenCalledWith({ commit: revision })
  })

  it('keeps the chosen branch after a refused switch from a failed checkout', async () => {
    const { panel, switchBranch } = await renderPanel(invalidCheckout)

    await panel.get('.core-scope-actions button').trigger('click')
    const picker = panel.get('[data-testid="core-branch"]')
    expect(picker.text()).toContain('选择分支')
    await picker.trigger('click')
    const feature = panel.findAll('[role="option"]').find((option) => option.text() === 'feature')
    expect(feature).toBeDefined()
    await feature?.trigger('click')
    await panel.get('.core-branch-picker').trigger('submit')
    await flushPromises()

    expect(switchBranch).toHaveBeenCalledWith({ branch: 'feature' })
    expect(panel.get('.core-branch-picker').text()).toContain('feature')
  })

  it('disables both selection controls and the branch picker while DSH Web starts', async () => {
    const { panel } = await renderPanel({
      ...invalidCheckout,
      launch: { kind: 'starting' }
    })

    expect(panel.get('.core-scope-actions button').attributes('disabled')).toBeDefined()
    expect(panel.get('button.version-switch-action').attributes('disabled')).toBeDefined()
    expect(panel.get('[data-testid="version-check-v1.0.0"]').attributes('disabled')).toBeDefined()
  })
})
