import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, toRaw } from 'vue'
import {
  apiOk,
  type DesktopApi,
  type LauncherHarnessState,
  type RemoteConnectionStatus,
  type RemoteConnectionView
} from '@/shared/contracts'
import type { P2PComputerView, P2PConnectionView } from '@/shared/p2p-management'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import {
  p2pConnections,
  p2pManagement,
  remoteConnectionsState,
  resetRemoteConnectionsForTests
} from '@/app/domains/remote-connections'
import RuntimeTabsPanel from '../components/RuntimeTabsPanel.vue'
import {
  resetRuntimeBrowserForTests,
  runtimeBrowser,
  type RuntimeTabId
} from '../runtimeBrowserState'

const sshId = '11111111-1111-4111-8111-111111111111'
const secondSshId = '22222222-2222-4222-8222-222222222222'
const sshTab = `remote:${sshId}` as const
const secondSshTab = `remote:${secondSshId}` as const
const sshUrl = 'http://127.0.0.1:41001/?token=ssh-test'
const localUrl = 'http://127.0.0.1:3088/?token=local-test'
const peerEntry = {
  url: 'http://127.0.0.1:41234/?token=peer-test',
  partition: 'persist:dshker-peer-close-test'
}
const computer: P2PComputerView = {
  connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  serviceId: 'a'.repeat(12),
  displayName: '办公室 Windows',
  pairId: '1'.repeat(32),
  networkId: '2'.repeat(12),
  localDeviceId: '3'.repeat(12),
  remoteDeviceId: '4'.repeat(12),
  userId: '5'.repeat(12),
  localPublicKey: 'local-key',
  remotePublicKey: 'remote-key',
  pairRevision: 1,
  pairState: 'active'
}
const peerTab = `peer:${computer.connectionId}` as const
const peerView: P2PConnectionView = {
  serviceId: computer.serviceId,
  pairId: computer.pairId,
  attemptId: '6'.repeat(12),
  generation: 1,
  stage: 'ready',
  error: '',
  path: { localType: 'host', remoteType: 'host', protocol: 'udp' },
  runtimeGeneration: 1
}
const wrappers = new Set<VueWrapper>()

function sshConnection(
  status: RemoteConnectionStatus = { kind: 'ready', url: sshUrl },
  connectionId = sshId
): RemoteConnectionView {
  return {
    connectionId,
    configRevision: 'b'.repeat(64),
    displayName: connectionId === sshId ? '工作室 Mac' : '另一台 Mac',
    host: connectionId === sshId ? 'studio-mac' : 'other-mac',
    port: 22,
    user: 'dev',
    status,
    testStatus: { kind: 'passed' }
  }
}

function runningState(): LauncherHarnessState {
  return {
    kind: 'ready',
    harnessDirectory: '/managed/harness',
    remoteUrl: 'https://github.com/deepseek-ai/deepseek-harness.git',
    currentBranch: 'master',
    branches: ['master'],
    revision: '0123456789abcdef',
    launch: { kind: 'running', url: localUrl },
    port: { mode: 'auto' },
    commits: [],
    stableVersions: [],
    plugins: [],
    console: [],
    logFile: { path: '/managed/logs/dsh-web.log', exists: true, byteLength: 1 }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

/** Only the named IPC capabilities used by this component are installed. */
function installApi(connect?: DesktopApi['remoteConnections']['connect']) {
  const remote = {
    getState: vi.fn(async () => apiOk(remoteConnectionsState.value)),
    onStateChange: vi.fn(() => () => undefined),
    connect: vi.fn(connect ?? (async () => apiOk(remoteConnectionsState.value))),
    disconnect: vi.fn(async () => apiOk(remoteConnectionsState.value)),
    remove: vi.fn(async () => apiOk(remoteConnectionsState.value))
  }
  const harness = {
    start: vi.fn(async () => apiOk(runningState())),
    stop: vi.fn(async () => apiOk(runningState()))
  }
  const runtimeApi: DesktopApi['runtimeBrowser'] = {
    getPreferences: async () => apiOk({ zoomPercent: 100 }),
    setZoom: async ({ zoomPercent }) => apiOk({ zoomPercent }),
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
    onZoomChange: () => () => undefined
  }
  window.dshLauncher = {
    runtimeBrowser: runtimeApi,
    remoteConnections: remote,
    launcherHarness: harness
  } as unknown as DesktopApi
  return { remote, harness }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountPanel(): Promise<VueWrapper> {
  await settle()
  const wrapper = mount(RuntimeTabsPanel, { attachTo: document.body })
  wrappers.add(wrapper)
  await settle()
  prepareFrames(wrapper)
  return wrapper
}

/** Happy DOM has no Electron guest methods; tab state and DOM remain real. */
function prepareFrames(wrapper: VueWrapper): void {
  for (const frame of wrapper.findAll('webview')) {
    Object.assign(frame.element, {
      canGoBack: () => false,
      canGoForward: () => false,
      getURL: () => frame.attributes('src'),
      setZoomFactor: vi.fn()
    })
  }
}

function ids(): RuntimeTabId[] {
  return runtimeBrowser.tabs.value.map((tab) => tab.id)
}

function tab(id: RuntimeTabId) {
  return runtimeBrowser.tabs.value.find((value) => value.id === id)
}

async function closeTab(wrapper: VueWrapper, id: RuntimeTabId): Promise<void> {
  const close = wrapper.get<HTMLButtonElement>(`[data-testid="runtime-tab-close-${id}"]`)
  close.element.focus()
  await close.trigger('click')
  await settle()
}

async function addMenu(wrapper: VueWrapper): Promise<HTMLElement> {
  await wrapper.get('[data-testid="runtime-add-tab"]').trigger('click')
  await settle()
  const menu = document.querySelector<HTMLElement>('[data-testid="runtime-add-tab-menu"]')
  if (menu === null) throw new Error('Expected the add-tab menu')
  return menu
}

function option(menu: HTMLElement, source: 'ssh' | 'peer', id: string): HTMLButtonElement {
  const button = menu.querySelector<HTMLButtonElement>(
    `[data-testid="runtime-add-${source}-${id}"]`
  )
  if (button === null) throw new Error(`Expected ${source} option ${id}`)
  return button
}

beforeEach(async () => {
  vi.restoreAllMocks()
  resetRemoteConnectionsForTests()
  resetRuntimeBrowserForTests()
  harnessState.value = runningState()
  p2pManagement.catalog.value = {
    revision: 'b'.repeat(64),
    catalogId: 'd'.repeat(12),
    services: [],
    computers: [computer],
    forgottenServiceIds: []
  }
  p2pConnections.state.peers = []
  p2pConnections.state.helperError = ''
  p2pConnections.state.lastRefusal = ''
  p2pConnections.state.resultUnconfirmed = false
  vi.spyOn(p2pManagement, 'ensureBuiltinService').mockResolvedValue()
  vi.spyOn(p2pConnections, 'read').mockResolvedValue()
  vi.spyOn(p2pConnections, 'entry').mockResolvedValue(peerEntry)
  vi.spyOn(p2pConnections, 'connect').mockResolvedValue()
  vi.spyOn(p2pConnections, 'disconnect').mockResolvedValue()
  await settle()
})

afterEach(async () => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers.clear()
  resetRemoteConnectionsForTests()
  resetRuntimeBrowserForTests()
  harnessState.value = undefined
  p2pManagement.catalog.value = null
  p2pConnections.state.peers = undefined
  window.dshLauncher = undefined
  await settle()
  vi.restoreAllMocks()
})

describe('runtime tab closing state', () => {
  it('refuses the local tab and unknown remote identities without changing state', async () => {
    remoteConnectionsState.value = { connections: [sshConnection()] }
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    runtimeBrowser.updateTab(sshTab, { url: 'http://127.0.0.1:41001/page', title: 'Page' })
    const before = structuredClone(runtimeBrowser.tabs.value)

    expect(runtimeBrowser.closeRemoteTab('local')).toBe(false)
    expect(runtimeBrowser.closeRemoteTab('remote:unknown')).toBe(false)
    expect(runtimeBrowser.closeRemoteTab('peer:unknown')).toBe(false)
    expect(runtimeBrowser.closeRemoteTab(peerTab)).toBe(false)
    expect(runtimeBrowser.tabs.value).toEqual(before)
    expect(runtimeBrowser.activeTabId.value).toBe(sshTab)
  })

  it('selects the right neighbor, then the left neighbor, then local when active tabs close', async () => {
    remoteConnectionsState.value = {
      connections: [sshConnection(), sshConnection({ kind: 'ready', url: sshUrl }, secondSshId)]
    }
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    runtimeBrowser.openRemoteTab(secondSshTab)
    runtimeBrowser.openRemoteTab(peerTab)
    runtimeBrowser.activeTabId.value = secondSshTab

    expect(runtimeBrowser.closeRemoteTab(secondSshTab)).toBe(true)
    expect(ids()).toEqual(['local', sshTab, peerTab])
    expect(runtimeBrowser.activeTabId.value).toBe(peerTab)
    expect(runtimeBrowser.closeRemoteTab(peerTab)).toBe(true)
    expect(runtimeBrowser.activeTabId.value).toBe(sshTab)
    expect(runtimeBrowser.closeRemoteTab(sshTab)).toBe(true)
    expect(ids()).toEqual(['local'])
    expect(runtimeBrowser.activeTabId.value).toBe('local')
    expect(runtimeBrowser.closeRemoteTab(sshTab)).toBe(false)
  })

  it('preserves the active tab and clears only closed-tab navigation before reopening', async () => {
    remoteConnectionsState.value = { connections: [sshConnection()] }
    p2pConnections.state.peers = [peerView]
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    runtimeBrowser.updateTab(sshTab, { url: 'http://127.0.0.1:41001/old', title: 'Old SSH page' })
    runtimeBrowser.openRemoteTab(peerTab)
    runtimeBrowser.updateTab(peerTab, { url: 'http://127.0.0.1:41234/keep', title: 'Peer page' })

    expect(runtimeBrowser.closeRemoteTab(sshTab)).toBe(true)
    expect(runtimeBrowser.activeTabId.value).toBe(peerTab)
    expect(tab(peerTab)).toMatchObject({ url: 'http://127.0.0.1:41234/keep', title: 'Peer page' })
    // A late navigation event from the removed guest cannot restore its page.
    runtimeBrowser.updateTab(sshTab, { url: 'http://127.0.0.1:41001/late', title: 'Late page' })
    expect(runtimeBrowser.openRemoteTab(sshTab)).toBe(true)
    expect(tab(sshTab)).toMatchObject({ url: sshUrl, title: '' })
    expect(vi.mocked(p2pConnections.entry)).toHaveBeenCalledTimes(1)
  })

  it('replaces a closed peer entry when its connection generation changes', async () => {
    p2pConnections.state.peers = [peerView]
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    runtimeBrowser.updateTab(peerTab, { url: 'http://127.0.0.1:41234/old', title: 'Old page' })
    expect(runtimeBrowser.closeRemoteTab(peerTab)).toBe(true)
    const replacementEntry = {
      url: 'http://127.0.0.1:41235/?token=new-attempt',
      partition: peerEntry.partition
    }
    vi.mocked(p2pConnections.entry).mockResolvedValue(replacementEntry)
    p2pConnections.state.peers = [
      { ...peerView, generation: 2, attemptId: '7'.repeat(12), runtimeGeneration: 2 }
    ]
    await settle()

    expect(ids()).toEqual(['local'])
    expect(p2pConnections.entry).toHaveBeenLastCalledWith(computer.serviceId, computer.pairId, 2)
    expect(runtimeBrowser.openRemoteTab(peerTab)).toBe(true)
    expect(tab(peerTab)).toMatchObject({
      url: replacementEntry.url,
      partition: replacementEntry.partition,
      title: ''
    })
  })
})

describe('runtime tab close controls', () => {
  it('revokes guest admission when a computer is removed before suspended re-addition', async () => {
    p2pConnections.state.peers = [peerView]
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    const selector = `[data-testid="runtime-webview-${peerTab}"]`
    expect(wrapper.find(selector).exists()).toBe(true)
    const current = p2pManagement.catalog.value!
    p2pManagement.catalog.value = { ...current, computers: [] }
    await settle()
    expect(wrapper.find(selector).exists()).toBe(false)
    p2pConnections.state.peers = [{ ...peerView, stage: 'suspended' }]
    p2pManagement.catalog.value = { ...current, computers: [{ ...computer }] }
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    await settle()
    expect(wrapper.find(selector).exists()).toBe(false)
    expect(p2pConnections.entry).toHaveBeenCalledTimes(1)
  })

  it('keeps a peer guest and deep URL unchanged when SSH records refresh', async () => {
    p2pConnections.state.peers = [peerView]
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    const selector = `[data-testid="runtime-webview-${peerTab}"]`
    const deepUrl = 'http://127.0.0.1:41234/project/keep-this-session'
    runtimeBrowser.updateTab(peerTab, { url: deepUrl })
    await settle()
    const originalGuest = wrapper.get(selector).element

    for (const stage of ['ready', 'suspended'] as const) {
      p2pConnections.state.peers = [{ ...peerView, stage }]
      remoteConnectionsState.value = { connections: [sshConnection({ kind: 'connecting' })] }
      await settle()
      expect(wrapper.get(selector).element).toBe(originalGuest)
      expect(wrapper.get(selector).attributes('src')).toBe(deepUrl)
    }
  })

  it('does not authorize a new guest by reopening a suspended primary entry', async () => {
    p2pConnections.state.peers = [peerView]
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    const selector = `[data-testid="runtime-webview-${peerTab}"]`
    const originalGuest = wrapper.get(selector).element
    await closeTab(wrapper, peerTab)

    p2pConnections.state.peers = [{ ...peerView, stage: 'suspended' }]
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    await settle()
    expect(wrapper.find(selector).exists()).toBe(false)
    expect(p2pConnections.entry).toHaveBeenCalledTimes(1)

    p2pConnections.state.peers = [peerView]
    await settle()
    expect(wrapper.get(selector).element).not.toBe(originalGuest)
    expect(wrapper.get(selector).attributes('src')).toBe(peerEntry.url)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })

  it('preserves the original guest and navigated src through repeated primary suspension', async () => {
    p2pConnections.state.peers = [peerView]
    const { harness } = installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    const selector = `[data-testid="runtime-webview-${peerTab}"]`
    const deepUrl = 'http://127.0.0.1:41234/project/original-session'
    runtimeBrowser.updateTab(peerTab, { url: deepUrl })
    await settle()
    const originalGuest = wrapper.get(selector).element

    for (let cycle = 0; cycle < 3; cycle++) {
      p2pConnections.state.peers = [{ ...peerView, stage: 'suspended' }]
      await settle()
      expect(wrapper.get(selector).element).toBe(originalGuest)
      expect(wrapper.get(selector).attributes('src')).toBe(deepUrl)
      expect(wrapper.get('[data-testid="runtime-peer-recovering"]').attributes('role')).toBe(
        'status'
      )
      expect(
        wrapper
          .get(`[data-testid="runtime-tab-${peerTab}"]`)
          .element.parentElement?.getAttribute('data-state')
      ).toBe('suspended')
      p2pConnections.state.peers = [peerView]
      await settle()
      expect(wrapper.get(selector).element).toBe(originalGuest)
      expect(wrapper.get(selector).attributes('src')).toBe(deepUrl)
      expect(wrapper.find('[data-testid="runtime-peer-recovering"]').exists()).toBe(false)
    }
    expect(p2pConnections.entry).toHaveBeenCalledTimes(1)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()

    p2pConnections.state.peers = [{ ...peerView, stage: 'suspended' }]
    p2pManagement.catalog.value = {
      ...p2pManagement.catalog.value!,
      computers: [{ ...computer, pairState: 'revoked' }]
    }
    await settle()
    expect(wrapper.find(selector).exists()).toBe(false)
  })

  it('closes a focused remote tab with Delete and keeps local open on the same key', async () => {
    remoteConnectionsState.value = {
      connections: [sshConnection(), sshConnection({ kind: 'ready', url: sshUrl }, secondSshId)]
    }
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    runtimeBrowser.openRemoteTab(secondSshTab)
    const wrapper = await mountPanel()
    const selected = wrapper.get<HTMLButtonElement>(`[data-testid="runtime-tab-${sshTab}"]`)
    await selected.trigger('click')
    selected.element.focus()
    expect(selected.attributes('role')).toBe('tab')
    expect(selected.attributes('aria-selected')).toBe('true')
    await selected.trigger('keydown', { key: 'Delete' })
    await settle()

    expect(ids()).toEqual(['local', secondSshTab])
    expect(runtimeBrowser.activeTabId.value).toBe(secondSshTab)
    expect(document.activeElement).toBe(
      wrapper.get(`[data-testid="runtime-tab-${secondSshTab}"]`).element
    )

    const local = wrapper.get<HTMLButtonElement>('[data-testid="runtime-tab-local"]')
    await local.trigger('click')
    local.element.focus()
    await local.trigger('keydown', { key: 'Delete' })
    await settle()
    expect(ids()).toEqual(['local', secondSshTab])
    expect(runtimeBrowser.activeTabId.value).toBe('local')
    expect(document.activeElement).toBe(local.element)
    expect(wrapper.find('[data-testid="runtime-webview-local"]').exists()).toBe(true)
  })

  it('uses separate close buttons and focuses the selected neighbor after active and background closes', async () => {
    remoteConnectionsState.value = {
      connections: [sshConnection(), sshConnection({ kind: 'ready', url: sshUrl }, secondSshId)]
    }
    p2pConnections.state.peers = [peerView]
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    runtimeBrowser.openRemoteTab(secondSshTab)
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="runtime-tab-close-local"]').exists()).toBe(false)
    const close = wrapper.get(`[data-testid="runtime-tab-close-${secondSshTab}"]`)
    expect(close.element.closest('[role="tab"]')).toBeNull()
    expect(close.element.parentElement?.closest('button')).toBeNull()
    expect(close.attributes('aria-label')).toContain('另一台 Mac')

    await wrapper.get(`[data-testid="runtime-tab-${secondSshTab}"]`).trigger('click')
    await closeTab(wrapper, secondSshTab)
    expect(runtimeBrowser.activeTabId.value).toBe(peerTab)
    expect(document.activeElement).toBe(
      wrapper.get(`[data-testid="runtime-tab-${peerTab}"]`).element
    )
    expect(wrapper.get(`[data-testid="runtime-tab-${peerTab}"]`).attributes('aria-selected')).toBe(
      'true'
    )

    await closeTab(wrapper, sshTab)
    expect(runtimeBrowser.activeTabId.value).toBe(peerTab)
    expect(document.activeElement).toBe(
      wrapper.get(`[data-testid="runtime-tab-${peerTab}"]`).element
    )
    await closeTab(wrapper, peerTab)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="runtime-tab-local"]').element)
  })

  it('unmounts a closed SSH guest, keeps its record and runtime, and reopens it from plus', async () => {
    const record = sshConnection()
    remoteConnectionsState.value = { connections: [record] }
    const api = installApi()
    await settle()
    runtimeBrowser.openRemoteTab(sshTab)
    const wrapper = await mountPanel()
    const guest = wrapper.get(`[data-testid="runtime-webview-${sshTab}"]`).element
    const stopGuest = vi.fn()
    Object.assign(guest, { stop: stopGuest })
    runtimeBrowser.updateTab(sshTab, { url: 'http://127.0.0.1:41001/old', title: 'Old title' })
    await settle()
    const openMenu = await addMenu(wrapper)
    expect(openMenu.querySelector(`[data-testid="runtime-add-ssh-${sshId}"]`)).toBeNull()
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await settle()

    await closeTab(wrapper, sshTab)
    expect(guest.isConnected).toBe(false)
    expect(wrapper.find(`[data-testid="runtime-webview-${sshTab}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-testid="runtime-webview-local"]').exists()).toBe(true)
    expect(remoteConnectionsState.value.connections).toEqual([record])
    expect(api.remote.disconnect).not.toHaveBeenCalled()
    expect(api.remote.remove).not.toHaveBeenCalled()
    expect(api.harness.start).not.toHaveBeenCalled()
    expect(api.harness.stop).not.toHaveBeenCalled()
    expect(stopGuest).not.toHaveBeenCalled()

    option(await addMenu(wrapper), 'ssh', sshId).click()
    await settle()
    expect(ids()).toEqual(['local', sshTab])
    expect(wrapper.get(`[data-testid="runtime-webview-${sshTab}"]`).element).not.toBe(guest)
    expect(wrapper.get(`[data-testid="runtime-webview-${sshTab}"]`).attributes('src')).toBe(sshUrl)
    expect(tab(sshTab)?.title).toBe('')
    expect(api.remote.connect).not.toHaveBeenCalled()
  })

  it('unmounts and reopens a ready peer without disconnecting or replacing its generation entry', async () => {
    p2pConnections.state.peers = [peerView]
    const api = installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    const guest = wrapper.get(`[data-testid="runtime-webview-${peerTab}"]`).element
    runtimeBrowser.updateTab(peerTab, { url: 'http://127.0.0.1:41234/old', title: 'Old peer page' })
    const catalogBefore = structuredClone(toRaw(p2pManagement.catalog.value))
    const peersBefore = structuredClone(toRaw(p2pConnections.state.peers))

    await closeTab(wrapper, peerTab)
    expect(guest.isConnected).toBe(false)
    expect(p2pManagement.catalog.value).toEqual(catalogBefore)
    expect(p2pConnections.state.peers).toEqual(peersBefore)
    expect(p2pConnections.disconnect).not.toHaveBeenCalled()
    expect(api.remote.remove).not.toHaveBeenCalled()
    expect(api.harness.start).not.toHaveBeenCalled()
    expect(api.harness.stop).not.toHaveBeenCalled()

    option(await addMenu(wrapper), 'peer', computer.connectionId).click()
    await settle()
    const reopened = wrapper.get(`[data-testid="runtime-webview-${peerTab}"]`)
    expect(reopened.element).not.toBe(guest)
    expect(reopened.attributes('src')).toBe(peerEntry.url)
    expect(reopened.attributes('partition')).toBe(peerEntry.partition)
    expect(tab(peerTab)?.title).toBe('')
    expect(p2pConnections.entry).toHaveBeenCalledTimes(1)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })

  it.each(['disconnected', 'failed'] as const)(
    'opens a %s SSH connection and connects exactly once',
    async (kind) => {
      const status: RemoteConnectionStatus =
        kind === 'failed'
          ? { kind, code: 'remote.tunnel_failed', message: 'Connection failed' }
          : { kind }
      remoteConnectionsState.value = { connections: [sshConnection(status)] }
      const api = installApi(async () => ({ ok: true, data: { connections: [sshConnection()] } }))
      const wrapper = await mountPanel()
      const choice = option(await addMenu(wrapper), 'ssh', sshId)
      expect(choice.disabled).toBe(false)
      choice.focus()
      choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await settle()

      expect(ids()).toEqual(['local', sshTab])
      expect(runtimeBrowser.activeTabId.value).toBe(sshTab)
      expect(api.remote.connect).toHaveBeenCalledExactlyOnceWith({ connectionId: sshId })
      expect(wrapper.get(`[data-testid="runtime-webview-${sshTab}"]`).attributes('src')).toBe(
        sshUrl
      )
    }
  )

  it('keeps an already connecting SSH option disabled', async () => {
    remoteConnectionsState.value = { connections: [sshConnection({ kind: 'connecting' })] }
    const api = installApi()
    const wrapper = await mountPanel()
    const choice = option(await addMenu(wrapper), 'ssh', sshId)
    expect(choice.disabled).toBe(true)
    choice.click()
    await settle()
    expect(ids()).toEqual(['local'])
    expect(api.remote.connect).not.toHaveBeenCalled()
  })
})

describe('closing while remote work is pending', () => {
  it('does not recreate an SSH tab when its connect answer arrives, then reopens the ready guest', async () => {
    remoteConnectionsState.value = { connections: [sshConnection({ kind: 'disconnected' })] }
    const pending = deferred<Awaited<ReturnType<DesktopApi['remoteConnections']['connect']>>>()
    const api = installApi(() => pending.promise)
    const wrapper = await mountPanel()
    option(await addMenu(wrapper), 'ssh', sshId).click()
    await settle()
    expect(ids()).toEqual(['local', sshTab])
    expect(api.remote.connect).toHaveBeenCalledExactlyOnceWith({ connectionId: sshId })

    await closeTab(wrapper, sshTab)
    const pendingOption = option(await addMenu(wrapper), 'ssh', sshId)
    expect(pendingOption.disabled).toBe(true)
    pendingOption.click()
    await settle()
    expect(ids()).toEqual(['local'])
    expect(api.remote.connect).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await settle()
    pending.resolve({ ok: true, data: { connections: [sshConnection()] } })
    await settle()
    expect(ids()).toEqual(['local'])
    expect(runtimeBrowser.activeTabId.value).toBe('local')
    expect(wrapper.find(`[data-testid="runtime-webview-${sshTab}"]`).exists()).toBe(false)
    expect(remoteConnectionsState.value.connections[0]?.status.kind).toBe('ready')

    option(await addMenu(wrapper), 'ssh', sshId).click()
    await settle()
    expect(wrapper.get(`[data-testid="runtime-webview-${sshTab}"]`).attributes('src')).toBe(sshUrl)
    expect(api.remote.connect).toHaveBeenCalledTimes(1)
  })

  it('does not recreate a peer tab after its entry arrives, and reuses that entry on reopen', async () => {
    const pending = deferred<typeof peerEntry>()
    vi.mocked(p2pConnections.entry).mockReturnValue(pending.promise)
    p2pConnections.state.peers = [peerView]
    installApi()
    await settle()
    runtimeBrowser.openRemoteTab(peerTab)
    const wrapper = await mountPanel()
    expect(p2pConnections.entry).toHaveBeenCalledExactlyOnceWith(
      computer.serviceId,
      computer.pairId,
      1
    )
    await closeTab(wrapper, peerTab)

    pending.resolve(peerEntry)
    await settle()
    expect(ids()).toEqual(['local'])
    expect(runtimeBrowser.activeTabId.value).toBe('local')
    expect(wrapper.find(`[data-testid="runtime-webview-${peerTab}"]`).exists()).toBe(false)
    option(await addMenu(wrapper), 'peer', computer.connectionId).click()
    await settle()
    expect(wrapper.get(`[data-testid="runtime-webview-${peerTab}"]`).attributes('src')).toBe(
      peerEntry.url
    )
    expect(p2pConnections.entry).toHaveBeenCalledTimes(1)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })

  it('does not recreate a peer tab after connect completes, then opens its newly ready guest', async () => {
    const pending = deferred<void>()
    vi.mocked(p2pConnections.connect).mockImplementation(async () => {
      await pending.promise
      p2pConnections.state.peers = [peerView]
    })
    installApi()
    const wrapper = await mountPanel()
    option(await addMenu(wrapper), 'peer', computer.connectionId).click()
    await settle()
    expect(ids()).toEqual(['local', peerTab])
    expect(p2pConnections.connect).toHaveBeenCalledExactlyOnceWith(
      computer.serviceId,
      computer.pairId
    )
    await closeTab(wrapper, peerTab)

    pending.resolve()
    await settle()
    expect(ids()).toEqual(['local'])
    expect(runtimeBrowser.activeTabId.value).toBe('local')
    expect(p2pConnections.state.peers).toEqual([peerView])
    expect(wrapper.find(`[data-testid="runtime-webview-${peerTab}"]`).exists()).toBe(false)
    option(await addMenu(wrapper), 'peer', computer.connectionId).click()
    await settle()
    expect(wrapper.get(`[data-testid="runtime-webview-${peerTab}"]`).attributes('src')).toBe(
      peerEntry.url
    )
    expect(p2pConnections.connect).toHaveBeenCalledTimes(1)
  })
})
