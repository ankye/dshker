import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { apiFail, apiOk, type DesktopApi, type LauncherHarnessState } from '@/shared/contracts'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import RuntimeTabsPanel from '../components/RuntimeTabsPanel.vue'
import { runtimeBrowser } from '../runtimeBrowserState'

const runtimeUrl = 'http://127.0.0.1:3088/?token=must-not-be-copied'

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
  const wrapper = mount(RuntimeTabsPanel)
  await flushPromises()
  return wrapper
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
    runtimeBrowser.resetTabs()
    harnessState.value = undefined
    vi.restoreAllMocks()
  })

  afterEach(() => {
    runtimeBrowser.resetTabs()
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
