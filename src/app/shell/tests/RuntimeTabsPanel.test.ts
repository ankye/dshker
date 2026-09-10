import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { apiFail, apiOk, type DesktopApi, type LauncherHarnessState } from '@/shared/contracts'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import {
  p2pConnections,
  p2pManagement,
  remoteConnectionsState
} from '@/app/domains/remote-connections'
import type { P2PComputerView, P2PConnectionView } from '@/shared/p2p-management'
import RuntimeTabsPanel from '../components/RuntimeTabsPanel.vue'
import { resetRuntimeBrowserForTests, runtimeBrowser } from '../runtimeBrowserState'

const runtimeUrl = 'http://127.0.0.1:3088/?token=must-not-be-copied'
const peerComputer: P2PComputerView = {
  connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  serviceId: 'a'.repeat(64),
  displayName: '办公室 Windows',
  pairId: '11111111111111111111111111111111',
  networkId: '2'.repeat(32),
  localDeviceId: '3'.repeat(32),
  remoteDeviceId: '4'.repeat(32),
  userId: '5'.repeat(32),
  localPublicKey: 'local-key',
  remotePublicKey: 'remote-key',
  pairRevision: 1,
  pairState: 'active'
}
const peerConnection: P2PConnectionView = {
  serviceId: peerComputer.serviceId,
  pairId: peerComputer.pairId,
  attemptId: '6'.repeat(32),
  generation: 1,
  stage: 'ready',
  error: '',
  path: { localType: 'host', remoteType: 'host', protocol: 'udp' },
  runtimeGeneration: 1
}
const offlinePeer: P2PComputerView = {
  ...peerComputer,
  connectionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  displayName: '离线 Windows',
  pairId: '22222222222222222222222222222222'
}
const mountedWrappers = new Set<VueWrapper>()

function runningState(): LauncherHarnessState {
  return {
    kind: 'ready',
    harnessDirectory: '/managed/harness',
    remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    currentBranch: 'master',
    branches: ['master'],
    revision: '0123456789abcdef',
    launch: { kind: 'running', url: runtimeUrl },
    port: { mode: 'auto' },
    commits: [],
    stableVersions: [],
    plugins: [],
    console: [],
    logFile: { path: '/managed/logs/dsh-web.log', exists: true, byteLength: 1 }
  }
}

function installRuntimeApi(options: {
  readonly getPreferences?: DesktopApi['runtimeBrowser']['getPreferences']
  readonly setZoom?: DesktopApi['runtimeBrowser']['setZoom']
}) {
  let zoomListener: Parameters<DesktopApi['runtimeBrowser']['onZoomChange']>[0] | undefined
  const runtimeApi: DesktopApi['runtimeBrowser'] = {
    getPreferences: options.getPreferences ?? (async () => apiOk({ zoomPercent: 100 })),
    setZoom:
      options.setZoom ??
      (async ({ zoomPercent }) => {
        const result = apiOk({ zoomPercent })
        zoomListener?.(result)
        return result
      }),
    getHostRenderingInfo: async () =>
      apiOk({
        electronVersion: '42.4.0',
        chromiumVersion: '148.0.7778.254',
        displayScaleFactor: 2,
        displayColorSpace: 'Display P3',
        gpuCompositing: 'enabled',
        rasterization: 'enabled',
        multipleRasterThreads: 'enabled_on'
      }),
    onZoomChange: (listener) => {
      zoomListener = listener
      return () => {
        zoomListener = undefined
      }
    }
  }
  window.dshLauncher = { runtimeBrowser: runtimeApi } as DesktopApi
  return runtimeApi
}

async function mountRunningPanel(): Promise<VueWrapper> {
  harnessState.value = runningState()
  await nextTick()
  const wrapper = mount(RuntimeTabsPanel, { attachTo: document.body })
  mountedWrappers.add(wrapper)
  await flushPromises()
  return wrapper
}

function getAddMenu(): HTMLElement {
  const menu = document.querySelector<HTMLElement>('[data-testid="runtime-add-tab-menu"]')
  if (menu === null) throw new Error('Expected the teleported add-tab menu to be mounted')
  return menu
}

function prepareWebview(wrapper: VueWrapper, zoomFactor = 1) {
  const element = wrapper.get('webview').element as HTMLElement & {
    setZoomFactor: ReturnType<typeof vi.fn>
    getZoomFactor: ReturnType<typeof vi.fn>
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  Object.assign(element, {
    canGoBack: () => false,
    canGoForward: () => false,
    getURL: () => runtimeUrl,
    setZoomFactor: vi.fn(),
    getZoomFactor: vi.fn(() => zoomFactor),
    executeJavaScript: vi.fn(async () => ({
      devicePixelRatio: 2,
      visualViewportScale: 1,
      colorScheme: 'dark',
      rootBackgroundColor: 'rgb(18, 24, 32)',
      bodyBackgroundColor: 'rgba(0, 0, 0, 0)',
      textColor: 'rgb(238, 242, 248)',
      fontFamily: 'Inter, sans-serif',
      fontSize: '14px',
      fontSmoothing: 'antialiased'
    }))
  })
  return element
}

describe('RuntimeTabsPanel rendering controls', () => {
  beforeEach(() => {
    resetRuntimeBrowserForTests()
    remoteConnectionsState.value = { connections: [] }
    p2pManagement.catalog.value = null
    p2pConnections.state.peers = undefined
    p2pConnections.state.helperError = ''
    p2pConnections.state.resultUnconfirmed = false
    harnessState.value = undefined
    vi.restoreAllMocks()
  })

  afterEach(() => {
    for (const wrapper of mountedWrappers) wrapper.unmount()
    mountedWrappers.clear()
    resetRuntimeBrowserForTests()
    remoteConnectionsState.value = { connections: [] }
    p2pManagement.catalog.value = null
    p2pConnections.state.peers = undefined
    p2pConnections.state.helperError = ''
    p2pConnections.state.resultUnconfirmed = false
    harnessState.value = undefined
    window.dshLauncher = undefined
  })

  it('applies the persisted zoom at DOM readiness and changes only by fixed steps', async () => {
    const setZoom = vi.fn(async ({ zoomPercent }) => apiOk({ zoomPercent }))
    installRuntimeApi({ setZoom })
    const wrapper = await mountRunningPanel()
    const webview = prepareWebview(wrapper)

    await wrapper.get('webview').trigger('dom-ready')
    expect(webview.setZoomFactor).toHaveBeenCalledWith(1)

    await wrapper.get('[data-testid="runtime-zoom-increase"]').trigger('click')
    await flushPromises()
    expect(setZoom).toHaveBeenCalledWith({ zoomPercent: 110 })
    expect(webview.setZoomFactor).toHaveBeenLastCalledWith(1.1)

    await wrapper.get('[data-testid="runtime-zoom-reset"]').trigger('click')
    await flushPromises()
    expect(setZoom).toHaveBeenLastCalledWith({ zoomPercent: 100 })
    wrapper.unmount()
  })

  it('renders opened local and remote tabs without add or close controls', async () => {
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          configRevision: 'a'.repeat(64),
          displayName: '工作室 Mac',
          host: 'studio-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'disconnected' },
          testStatus: { kind: 'untested' }
        }
      ]
    }
    runtimeBrowser.openRemoteTab('remote:11111111-1111-4111-8111-111111111111')
    installRuntimeApi({})
    const wrapper = await mountRunningPanel()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('本地')
    expect(wrapper.text()).toContain('工作室 Mac')
    expect(wrapper.find('[data-testid="runtime-add-tab"]').exists()).toBe(true)
    expect(wrapper.find('.browser-tab-close').exists()).toBe(false)
    wrapper.unmount()
  })

  it('lists unopened LAN and SSH computers, then creates only the chosen tab', async () => {
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          configRevision: 'a'.repeat(64),
          displayName: '工作室 Mac',
          host: 'studio-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'ready', url: 'http://127.0.0.1:41001/?token=remote' },
          testStatus: { kind: 'passed' }
        },
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          configRevision: 'b'.repeat(64),
          displayName: '离线 Mac',
          host: 'offline-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'disconnected' },
          testStatus: { kind: 'untested' }
        }
      ]
    }
    p2pManagement.catalog.value = {
      revision: 'b'.repeat(64),
      catalogId: 'd'.repeat(32),
      services: [],
      computers: [peerComputer, offlinePeer],
      forgottenServiceIds: []
    }
    p2pConnections.state.peers = [peerConnection]
    installRuntimeApi({})
    const wrapper = await mountRunningPanel()
    await wrapper.get('[data-testid="runtime-add-tab"]').trigger('click')

    const menu = getAddMenu()
    expect(menu.textContent).toContain('局域网电脑')
    expect(menu.textContent).toContain('SSH 连接')
    const peerOption = menu.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-add-peer-cccccccc-cccc-4ccc-8ccc-cccccccccccc"]'
    )
    expect(peerOption).not.toBeNull()
    expect(peerOption?.disabled).toBe(false)
    const sshOption = menu.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-add-ssh-11111111-1111-4111-8111-111111111111"]'
    )
    expect(sshOption).not.toBeNull()
    expect(sshOption?.disabled).toBe(false)
    const offlinePeerOption = menu.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-add-peer-dddddddd-dddd-4ddd-8ddd-dddddddddddd"]'
    )
    expect(offlinePeerOption?.disabled).toBe(true)
    expect(offlinePeerOption?.classList.contains('runtime-add-tab-option--disabled')).toBe(true)
    const offlineSshOption = menu.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-add-ssh-22222222-2222-4222-8222-222222222222"]'
    )
    expect(offlineSshOption?.disabled).toBe(true)
    expect(menu.textContent).toContain('暂不可用')
    expect(
      Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[data-testid^="runtime-add-peer-"]')
      ).map((option) => option.dataset.testid)
    ).toEqual([
      'runtime-add-peer-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'runtime-add-peer-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    ])
    expect(
      Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-testid^="runtime-add-ssh-"]')).map(
        (option) => option.dataset.testid
      )
    ).toEqual([
      'runtime-add-ssh-11111111-1111-4111-8111-111111111111',
      'runtime-add-ssh-22222222-2222-4222-8222-222222222222'
    ])
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual(['local'])

    peerOption?.click()
    await nextTick()
    expect(runtimeBrowser.tabs.value.map((tab) => tab.id)).toEqual([
      'local',
      'peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ])
    expect(document.querySelector('[data-testid="runtime-add-tab-menu"]')).toBeNull()

    await wrapper.get('[data-testid="runtime-add-tab"]').trigger('click')
    const reopenedMenu = getAddMenu()
    expect(
      reopenedMenu.querySelector(
        '[data-testid="runtime-add-peer-cccccccc-cccc-4ccc-8ccc-cccccccccccc"]'
      )
    ).toBeNull()
    expect(
      reopenedMenu.querySelector(
        '[data-testid="runtime-add-ssh-11111111-1111-4111-8111-111111111111"]'
      )
    ).not.toBeNull()

    reopenedMenu.querySelector<HTMLButtonElement>('[data-testid="runtime-add-tab-close"]')?.click()
    await nextTick()
    expect(document.querySelector('[data-testid="runtime-add-tab-menu"]')).toBeNull()
    wrapper.unmount()
  })

  it('closes the add menu with Escape', async () => {
    installRuntimeApi({})
    const wrapper = await mountRunningPanel()
    const trigger = wrapper.get('[data-testid="runtime-add-tab"]')
    await trigger.trigger('click')
    const menu = getAddMenu()
    expect(menu.style.left).toMatch(/px$/u)
    expect(menu.style.width).toMatch(/px$/u)
    expect(menu.style.maxHeight).toMatch(/px$/u)

    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('[data-testid="runtime-add-tab-menu"]')).toBeNull()

    await trigger.trigger('click')
    expect(document.querySelector('[data-testid="runtime-add-tab-menu"]')).not.toBeNull()

    await trigger.trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(document.querySelector('[data-testid="runtime-add-tab-menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('mounts only the local guest until a remote workbench is opened', async () => {
    remoteConnectionsState.value = {
      connections: [
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          configRevision: 'a'.repeat(64),
          displayName: '工作室 Mac',
          host: 'studio-mac',
          port: 22,
          user: 'dev',
          status: { kind: 'ready', url: 'http://127.0.0.1:41001/?token=remote' },
          testStatus: { kind: 'passed' }
        },
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          configRevision: 'b'.repeat(64),
          displayName: '办公室 PC',
          host: 'office-pc',
          port: 22,
          user: 'dev',
          status: { kind: 'ready', url: 'http://127.0.0.1:41002/?token=remote' },
          testStatus: { kind: 'passed' }
        }
      ]
    }
    installRuntimeApi({})
    const wrapper = await mountRunningPanel()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="runtime-tab-local"]')).toBeDefined()
    expect(wrapper.findAll('webview')).toHaveLength(1)
    expect(wrapper.find('[data-testid="runtime-webview-local"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('blocks the guest instead of inventing a zoom for an invalid preference record', async () => {
    installRuntimeApi({
      getPreferences: async () => apiFail('managed.invalid_record', 'Invalid preference record.')
    })
    const wrapper = await mountRunningPanel()

    expect(wrapper.find('webview').exists()).toBe(false)
    expect(wrapper.text()).toContain('运行页设置不可用')
    expect(wrapper.get('button').text()).toBe('重新读取')
    wrapper.unmount()
  })

  it('copies rendering facts without reading or copying the credential-bearing URL', async () => {
    installRuntimeApi({})
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    const wrapper = await mountRunningPanel()
    prepareWebview(wrapper, 1.25)
    await wrapper.get('webview').trigger('dom-ready')

    await wrapper.get('[data-testid="runtime-rendering-info"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="runtime-rendering-popover"]').text()).toContain('Display P3')
    const copyButton = wrapper.findAll('button').find((button) => button.text() === '复制信息')
    expect(copyButton).toBeDefined()
    await copyButton!.trigger('click')
    await flushPromises()

    const copied = String(writeText.mock.calls[0]?.[0])
    expect(copied).toContain('页面缩放: 125%')
    expect(copied).not.toContain('must-not-be-copied')
    expect(copied).not.toContain('127.0.0.1')
    wrapper.unmount()
  })

  it('reports a clipboard failure instead of silently leaving copy unchanged', async () => {
    installRuntimeApi({})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (_text: string) => Promise.reject(new Error('denied'))) }
    })
    const wrapper = await mountRunningPanel()
    prepareWebview(wrapper)
    await wrapper.get('webview').trigger('dom-ready')
    await wrapper.get('[data-testid="runtime-rendering-info"]').trigger('click')
    await flushPromises()

    const copyButton = wrapper.findAll('button').find((button) => button.text() === '复制信息')
    expect(copyButton).toBeDefined()
    await copyButton!.trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('复制渲染信息失败')
    wrapper.unmount()
  })
})
