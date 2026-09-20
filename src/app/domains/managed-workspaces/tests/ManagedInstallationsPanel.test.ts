import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiResult,
  DesktopApi,
  ManagedExecutableSelection,
  ManagedWorkspaceView
} from '@/shared/contracts'
import { apiFail, apiOk } from '@/shared/contracts'
import type { ManagedInstallationsApi, ManagedInstallationsState } from '../installations'
import { selectListboxOption } from '@/tests/listbox'
import ManagedInstallationsPanel from '../components/ManagedInstallationsPanel.vue'

let priorDesktopApi: DesktopApi | undefined

beforeEach(() => {
  priorDesktopApi = window.dshLauncher
  window.dshLauncher = undefined
})

afterEach(() => {
  window.dshLauncher = priorDesktopApi
})

describe('ManagedInstallationsPanel', () => {
  it('shows an unavailable state instead of providing a renderer-side clone fallback', async () => {
    installDesktopApi(undefined)

    const wrapper = mount(ManagedInstallationsPanel, { props: { workspaces: [workspace()] } })
    await flushPromises()

    expect(wrapper.text()).toContain('安装管理桥接尚未提供')
    expect(wrapper.text()).toContain('没有本地替代操作')
    expect(wrapper.find('[data-testid="clone-harness"]').exists()).toBe(false)
  })

  it('keeps executable capability selection empty after native cancellation', async () => {
    const selectExecutable = vi.fn(
      async (): Promise<ApiResult<ManagedExecutableSelection>> =>
        apiFail('managed.selection_cancelled', 'Executable selection was cancelled.')
    )
    installDesktopApi({
      getState: vi.fn(async () => apiOk(state({ toolchains: [], installations: [] }))),
      selectExecutable,
      registerToolchain: vi.fn(),
      installBundledSeed: vi.fn(),
      cloneHarness: vi.fn(),
      switchRevision: vi.fn(),
      startHarness: vi.fn(),
      stopHarness: vi.fn()
    })

    const wrapper = mount(ManagedInstallationsPanel, { props: { workspaces: [workspace()] } })
    await flushPromises()
    await wrapper.get('[data-testid="select-executable-git"]').trigger('click')
    await flushPromises()

    expect(selectExecutable).toHaveBeenCalledWith('git')
    expect(wrapper.text()).toContain('已取消可执行文件选择，未保存任何路径')
    expect(wrapper.text()).toContain('managed.selection_cancelled')
    expect(wrapper.text()).not.toContain('cap_git')
    expect(wrapper.get('[data-testid="register-toolchain"]').attributes('disabled')).toBeDefined()
  })

  it('imports the packaged DSH through the same workspace and toolchain selection used by clones', async () => {
    const importedState = state({
      toolchains: [toolchain()],
      installations: [
        installation({
          requestedRevision: { kind: 'commit', value: 'a1b2c3d' },
          resolvedCommit: 'a1b2c3d'
        })
      ]
    })
    const installBundledSeed = vi.fn(async () => apiOk(importedState))
    installDesktopApi({
      getState: vi.fn(async () => apiOk(state({ toolchains: [toolchain()], installations: [] }))),
      selectExecutable: vi.fn(),
      registerToolchain: vi.fn(),
      installBundledSeed,
      cloneHarness: vi.fn(),
      switchRevision: vi.fn(),
      startHarness: vi.fn(),
      stopHarness: vi.fn()
    })

    const wrapper = mount(ManagedInstallationsPanel, { props: { workspaces: [workspace()] } })
    await flushPromises()
    await selectListboxOption(wrapper, 'installation-workspace', 'Alpha')
    await selectListboxOption(
      wrapper,
      'installation-toolchain',
      'toolchain_local · Git 2.47.1 · Node 22.12.0 · pnpm 9.15.0'
    )

    expect(
      wrapper.get('[data-testid="install-bundled-seed"]').attributes('disabled')
    ).toBeUndefined()
    await wrapper.get('[data-testid="install-bundled-seed-form"]').trigger('submit')
    await flushPromises()

    expect(installBundledSeed).toHaveBeenCalledWith({
      workspaceId: 'workspace_alpha',
      toolchainId: 'toolchain_local'
    })
    expect(wrapper.text()).toContain('内置 DSH 已作为普通受管安装导入当前工作区')
    expect(wrapper.text()).toContain('a1b2c3d')
    expect(wrapper.get('[data-testid="install-bundled-seed"]').attributes('disabled')).toBeDefined()
  })

  it('requires explicit workspace, executable capabilities, toolchain, remote, and ref before clone, switch, and start', async () => {
    const registeredState = state({ toolchains: [toolchain()], installations: [] })
    const clonedState = state({
      toolchains: [toolchain()],
      installations: [installation({ launch: { kind: 'stopped' } })]
    })
    const switchedState = state({
      toolchains: [toolchain()],
      installations: [
        installation({
          requestedRevision: { kind: 'tag', value: 'v0.1.0' },
          resolvedCommit: 'd4e5f6a',
          launch: { kind: 'stopped' }
        })
      ]
    })
    const startedState = state({
      toolchains: [toolchain()],
      installations: [
        installation({
          requestedRevision: { kind: 'tag', value: 'v0.1.0' },
          resolvedCommit: 'd4e5f6a',
          launch: { kind: 'running', launchId: 'launch_alpha' }
        })
      ]
    })
    const stoppedState = state({
      toolchains: [toolchain()],
      installations: [
        installation({
          requestedRevision: { kind: 'tag', value: 'v0.1.0' },
          resolvedCommit: 'd4e5f6a',
          launch: { kind: 'stopped', launchId: 'launch_alpha' }
        })
      ]
    })
    const selectExecutable = vi.fn(async (purpose: 'git' | 'node' | 'pnpm') =>
      apiOk({
        capabilityId: `cap_${purpose}`,
        purpose,
        displayName: `${purpose}-selected`
      })
    )
    const registerToolchain = vi.fn(async () =>
      apiOk({ toolchainId: 'toolchain_local', state: registeredState })
    )
    const cloneHarness = vi.fn(async () => apiOk(clonedState))
    const switchRevision = vi.fn(async () => apiOk(switchedState))
    const startHarness = vi.fn(async () => apiOk(startedState))
    const stopHarness = vi.fn(async () => apiOk(stoppedState))
    installDesktopApi({
      getState: vi.fn(async () => apiOk(state({ toolchains: [], installations: [] }))),
      selectExecutable,
      registerToolchain,
      installBundledSeed: vi.fn(),
      cloneHarness,
      switchRevision,
      startHarness,
      stopHarness
    })

    const wrapper = mount(ManagedInstallationsPanel, { props: { workspaces: [workspace()] } })
    await flushPromises()

    expect(wrapper.get('[data-testid="clone-harness"]').attributes('disabled')).toBeDefined()
    await selectListboxOption(wrapper, 'installation-workspace', 'Alpha')
    await wrapper.get('[data-testid="select-executable-git"]').trigger('click')
    await wrapper.get('[data-testid="select-executable-node"]').trigger('click')
    await wrapper.get('[data-testid="select-executable-pnpm"]').trigger('click')
    await flushPromises()

    expect(selectExecutable).toHaveBeenNthCalledWith(1, 'git')
    expect(selectExecutable).toHaveBeenNthCalledWith(2, 'node')
    expect(selectExecutable).toHaveBeenNthCalledWith(3, 'pnpm')
    expect(wrapper.get('[data-testid="register-toolchain"]').attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="register-toolchain"]').trigger('click')
    await flushPromises()

    expect(registerToolchain).toHaveBeenCalledWith({
      gitCapabilityId: 'cap_git',
      nodeCapabilityId: 'cap_node',
      pnpmCapabilityId: 'cap_pnpm'
    })
    expect(wrapper.get('[data-testid="installation-toolchain"]').text()).toContain(
      'toolchain_local · Git 2.47.1 · Node 22.12.0 · pnpm 9.15.0'
    )

    await wrapper.get('[data-testid="clone-remote-url"]').setValue('git@github.com:ankye/dsh.git')
    await selectListboxOption(wrapper, 'clone-revision-kind', 'Branch')
    await wrapper.get('[data-testid="clone-revision-value"]').setValue('main')
    await wrapper.get('[data-testid="clone-harness-form"]').trigger('submit')
    await flushPromises()

    expect(cloneHarness).toHaveBeenCalledWith({
      workspaceId: 'workspace_alpha',
      toolchainId: 'toolchain_local',
      remoteUrl: 'git@github.com:ankye/dsh.git',
      revision: { kind: 'branch', value: 'main' }
    })
    expect(wrapper.text()).toContain('a1b2c3d')
    expect(wrapper.text()).toContain('指定 Harness 版本已由主进程写入安装状态')

    await wrapper.get('input[name="managed-installation"]').setValue('installation_alpha')
    await selectListboxOption(wrapper, 'switch-revision-kind', 'Tag')
    await wrapper.get('[data-testid="switch-revision-value"]').setValue('v0.1.0')
    await wrapper.get('[data-testid="switch-revision-form"]').trigger('submit')
    await flushPromises()

    expect(switchRevision).toHaveBeenCalledWith({
      workspaceId: 'workspace_alpha',
      installationId: 'installation_alpha',
      revision: { kind: 'tag', value: 'v0.1.0' }
    })
    expect(wrapper.text()).toContain('d4e5f6a')

    await wrapper.get('[data-testid="start-harness"]').trigger('click')
    await flushPromises()

    expect(startHarness).toHaveBeenCalledWith({
      workspaceId: 'workspace_alpha',
      installationId: 'installation_alpha'
    })
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).toContain('launch_alpha')
    expect(wrapper.find('[data-testid="start-harness"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="stop-harness"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="stop-harness"]').trigger('click')
    await flushPromises()
    expect(stopHarness).toHaveBeenCalledWith({
      workspaceId: 'workspace_alpha',
      installationId: 'installation_alpha'
    })
    expect(wrapper.text()).toContain('未运行')
    expect(wrapper.text()).toContain('Harness 已按主进程确认的子进程生命周期停止')
  })

  it('preserves clone input and reports an authoritative rejection without inventing an installation', async () => {
    const cloneHarness = vi.fn(
      async (): Promise<ApiResult<ManagedInstallationsState>> =>
        apiFail('managed.git_operation_failed', 'Git failed.')
    )
    installDesktopApi({
      getState: vi.fn(async () => apiOk(state({ toolchains: [toolchain()], installations: [] }))),
      selectExecutable: vi.fn(),
      registerToolchain: vi.fn(),
      installBundledSeed: vi.fn(),
      cloneHarness,
      switchRevision: vi.fn(),
      startHarness: vi.fn(),
      stopHarness: vi.fn()
    })

    const wrapper = mount(ManagedInstallationsPanel, { props: { workspaces: [workspace()] } })
    await flushPromises()
    await selectListboxOption(wrapper, 'installation-workspace', 'Alpha')
    await selectListboxOption(
      wrapper,
      'installation-toolchain',
      'toolchain_local · Git 2.47.1 · Node 22.12.0 · pnpm 9.15.0'
    )
    await wrapper.get('[data-testid="clone-remote-url"]').setValue('git@github.com:ankye/dsh.git')
    await selectListboxOption(wrapper, 'clone-revision-kind', 'Commit')
    await wrapper.get('[data-testid="clone-revision-value"]').setValue('a1b2c3d')
    await wrapper.get('[data-testid="clone-harness-form"]').trigger('submit')
    await flushPromises()

    expect(cloneHarness).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="clone-remote-url"]').element).toHaveProperty(
      'value',
      'git@github.com:ankye/dsh.git'
    )
    expect(wrapper.text()).toContain('主进程拒绝了该操作')
    expect(wrapper.text()).toContain('managed.git_operation_failed')
    expect(wrapper.text()).toContain('此工作区尚未安装 Harness')
  })
})

function workspace(): ManagedWorkspaceView {
  return {
    workspaceId: 'workspace_alpha',
    displayName: 'Alpha',
    workingDirectoryCanonicalPath: '/work/alpha',
    rootNamespaces: []
  }
}

function toolchain() {
  return {
    toolchainId: 'toolchain_local',
    gitVersion: '2.47.1',
    nodeVersion: '22.12.0',
    pnpmVersion: '9.15.0'
  }
}

function installation(overrides: Partial<ManagedInstallationsState['installations'][number]> = {}) {
  return {
    installationId: 'installation_alpha',
    workspaceId: 'workspace_alpha',
    toolchainId: 'toolchain_local',
    remoteUrl: 'git@github.com:ankye/dsh.git',
    requestedRevision: { kind: 'branch' as const, value: 'main' },
    resolvedCommit: 'a1b2c3d',
    launch: { kind: 'stopped' as const },
    ...overrides
  }
}

function state({
  toolchains,
  installations
}: ManagedInstallationsState): ManagedInstallationsState {
  return { toolchains, installations }
}

function installDesktopApi(managedInstallations: ManagedInstallationsApi | undefined): void {
  window.dshLauncher = {
    apiVersion: 1,
    bootstrap: {
      getInfo: async () => apiFail('bootstrap.main_unavailable', 'Not used in this test.')
    },
    managed: {
      getState: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      selectDirectory: async () => apiFail('managed.selection_cancelled', 'Not used in this test.'),
      registerRoots: async () => apiFail('managed.missing_registry', 'Not used in this test.'),
      createWorkspace: async () => apiFail('managed.missing_registry', 'Not used in this test.')
    },
    ...(managedInstallations ? { managedInstallations } : {})
  } as unknown as DesktopApi
}
