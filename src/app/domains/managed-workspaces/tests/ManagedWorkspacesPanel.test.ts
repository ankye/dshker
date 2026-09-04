import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiResult,
  DesktopApi,
  DirectorySelectionPurpose,
  ExternalLinkErrorCode,
  ManagedDirectorySelection,
  ManagedLauncherState,
  ManagedWorkspaceView,
  RegisterManagedRootsRequest
} from '@/shared/contracts'
import { apiFail, apiOk } from '@/shared/contracts'
import ManagedWorkspacesPanel from '../components/ManagedWorkspacesPanel.vue'

const ROOT_KINDS = ['harness', 'plugins', 'presets', 'settings'] as const

let priorDesktopApi: DesktopApi | undefined

beforeEach(() => {
  priorDesktopApi = window.dshLauncher
  window.dshLauncher = undefined
})

afterEach(() => {
  window.dshLauncher = priorDesktopApi
})

describe('ManagedWorkspacesPanel', () => {
  it('requires all four purpose-bound selections before it submits root registration', async () => {
    const registerRoots = vi.fn(
      async (_request: RegisterManagedRootsRequest): Promise<ApiResult<ManagedLauncherState>> =>
        apiOk(readyState())
    )
    const selectDirectory = vi.fn(
      async (purpose: DirectorySelectionPurpose): Promise<ApiResult<ManagedDirectorySelection>> =>
        apiOk({
          capabilityId: `cap_${purpose.replace(':', '_')}`,
          purpose,
          displayName: `${purpose}-directory`
        })
    )
    installDesktopApi({
      getState: vi.fn(async (): Promise<ApiResult<ManagedLauncherState>> => apiOk(setupState())),
      selectDirectory,
      registerRoots,
      createWorkspace: vi.fn()
    })

    const wrapper = mount(ManagedWorkspacesPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('注册四个独立目录')
    expect(wrapper.text()).toContain('Harness 的 ~/.dsh 不在此处注册、迁移或重建')
    expect(wrapper.get('[data-testid="register-roots"]').attributes('disabled')).toBeDefined()

    for (const rootKind of ROOT_KINDS) {
      await wrapper.get(`[data-testid="select-root-${rootKind}"]`).trigger('click')
      await flushPromises()
    }

    expect(selectDirectory).toHaveBeenNthCalledWith(1, 'managed-root:harness')
    expect(selectDirectory).toHaveBeenNthCalledWith(2, 'managed-root:plugins')
    expect(selectDirectory).toHaveBeenNthCalledWith(3, 'managed-root:presets')
    expect(selectDirectory).toHaveBeenNthCalledWith(4, 'managed-root:settings')
    expect(wrapper.get('[data-testid="register-roots"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="register-roots"]').trigger('click')
    await flushPromises()

    expect(registerRoots).toHaveBeenCalledWith({
      selections: ROOT_KINDS.map((kind) => ({
        kind,
        capabilityId: `cap_managed-root_${kind}`
      }))
    })
    expect(wrapper.text()).toContain('已注册目录')
    expect(wrapper.text()).toContain('/managed/harness')
    expect(wrapper.text()).toContain('没有已注册的工作区')
  })

  it('keeps setup visible and reports a native cancellation without recording a path', async () => {
    const selectDirectory = vi.fn(
      async (): Promise<ApiResult<ManagedDirectorySelection>> =>
        apiFail('managed.selection_cancelled', 'Directory selection was cancelled.')
    )
    installDesktopApi({
      getState: vi.fn(async (): Promise<ApiResult<ManagedLauncherState>> => apiOk(setupState())),
      selectDirectory,
      registerRoots: vi.fn(),
      createWorkspace: vi.fn()
    })

    const wrapper = mount(ManagedWorkspacesPanel)
    await flushPromises()
    await wrapper.get('[data-testid="select-root-harness"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已取消目录选择，未保存任何路径')
    expect(wrapper.text()).toContain('managed.selection_cancelled')
    expect(wrapper.text()).toContain('注册四个独立目录')
    expect(wrapper.text()).not.toContain('cap_')
  })

  it('shows the main-process recovery state instead of replacing it with setup', async () => {
    installDesktopApi({
      getState: vi.fn(
        async (): Promise<ApiResult<ManagedLauncherState>> =>
          apiOk({ kind: 'recovery-required', code: 'managed.invalid_bootstrap_locator' })
      ),
      selectDirectory: vi.fn(),
      registerRoots: vi.fn(),
      createWorkspace: vi.fn()
    })

    const wrapper = mount(ManagedWorkspacesPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('注册表需要恢复')
    expect(wrapper.text()).toContain('managed.invalid_bootstrap_locator')
    expect(wrapper.text()).not.toContain('注册四个独立目录')
  })

  it('requires a separately selected working-directory capability before it creates a workspace', async () => {
    const createWorkspace = vi.fn(
      async (): Promise<ApiResult<ManagedLauncherState>> =>
        apiOk(
          readyState([
            {
              workspaceId: 'workspace_alpha',
              displayName: 'Alpha',
              workingDirectoryCanonicalPath: '/work/alpha',
              rootNamespaces: ROOT_KINDS.map((kind) => ({
                rootId: `root_${kind}`,
                namespace: 'workspaces/workspace_alpha'
              }))
            }
          ])
        )
    )
    const selectDirectory = vi.fn(
      async (purpose: DirectorySelectionPurpose): Promise<ApiResult<ManagedDirectorySelection>> =>
        apiOk({
          capabilityId: 'cap_working_directory',
          purpose,
          displayName: 'alpha'
        })
    )
    installDesktopApi({
      getState: vi.fn(async (): Promise<ApiResult<ManagedLauncherState>> => apiOk(readyState())),
      selectDirectory,
      registerRoots: vi.fn(),
      createWorkspace
    })

    const wrapper = mount(ManagedWorkspacesPanel)
    await flushPromises()

    expect(
      wrapper.get('[data-testid="workspace-display-name"]').attributes('disabled')
    ).toBeDefined()
    await wrapper.get('[data-testid="select-working-directory"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="workspace-display-name"]').setValue('Alpha')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(selectDirectory).toHaveBeenCalledWith('workspace-working-directory')
    expect(createWorkspace).toHaveBeenCalledWith({
      displayName: 'Alpha',
      workingDirectoryCapabilityId: 'cap_working_directory'
    })
    expect(wrapper.text()).toContain('Alpha')
    expect(wrapper.text()).toContain('/work/alpha')
    expect(wrapper.text()).toContain('工作区已创建')
  })

  it('hides workspace management and own headers in the embedded settings view', async () => {
    installDesktopApi({
      getState: vi.fn(async (): Promise<ApiResult<ManagedLauncherState>> => apiOk(readyState())),
      selectDirectory: vi.fn(),
      registerRoots: vi.fn(),
      createWorkspace: vi.fn()
    })

    const wrapper = mount(ManagedWorkspacesPanel, {
      props: { embedded: true, showPort: false, showInstallations: false }
    })
    await flushPromises()

    // Root rows still render so the registered layout is visible in Settings.
    expect(wrapper.findAll('.managed-registered-root')).toHaveLength(ROOT_KINDS.length)
    expect(wrapper.text()).toContain('/managed/harness')
    // Workspace management belongs to the dedicated route, not to Settings.
    expect(wrapper.find('.managed-workspace-section').exists()).toBe(false)
    expect(wrapper.find('.managed-create-workspace').exists()).toBe(false)
    expect(wrapper.find('.managed-section-header').exists()).toBe(false)
    expect(wrapper.get('.managed-ready').attributes('data-embedded')).toBe('true')
  })
})

function setupState(): ManagedLauncherState {
  return { kind: 'setup-required', code: 'managed.missing_bootstrap_locator' }
}

function readyState(workspaces: readonly ManagedWorkspaceView[] = []): ManagedLauncherState {
  return {
    kind: 'ready',
    roots: ROOT_KINDS.map((kind) => ({
      rootId: `root_${kind}`,
      kind,
      canonicalPath: `/managed/${kind}`
    })),
    workspaces
  }
}

function installDesktopApi(managed: DesktopApi['managed']): void {
  window.dshLauncher = {
    apiVersion: 1,
    bootstrap: {
      getInfo: async () =>
        apiFail('bootstrap.main_unavailable', 'Bootstrap is not used in this test.')
    },
    managed,
    managedInstallations: {
      getState: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      selectExecutable: async () =>
        apiFail('managed.selection_cancelled', 'Not used in this test.'),
      registerToolchain: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      installBundledSeed: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      cloneHarness: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      switchRevision: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      startHarness: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      stopHarness: async () => apiFail('managed.missing_registry', 'Not used in this test.')
    },
    tokenUsage: {
      getState: async () => apiFail('managed.missing_registry', 'Not used in this test.')
    },
    launcherHarness: {
      getState: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      onConsoleAppend: () => () => undefined,
      start: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      stop: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      refreshVersions: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      update: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      switchVersion: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      switchBranch: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      installPlugin: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      installPluginArchive: async () =>
        apiFail('managed.missing_registry', 'Not used in this test.'),
      refreshPlugins: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      updatePlugin: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      adoptPlugin: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      uninstallPlugin: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      revealLog: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      exportLog: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      setPort: async () => apiFail('managed.missing_registry', 'Not used in this test.')
    },
    pluginCatalog: {
      getState: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      refresh: async () => apiFail('managed.missing_registry', 'Not used in this test.')
    },
    externalLinks: {
      open: async (): Promise<ApiResult<void, ExternalLinkErrorCode>> => ({
        ok: true,
        data: undefined
      })
    }
  }
}
