import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFail, apiOk, type DesktopApi } from '@/shared/contracts'
import type { P2PComputerView, P2PNetworkChoicesView } from '@/shared/p2p-management'
import {
  p2pManagement,
  p2pAccounts,
  p2pConnections,
  p2pPairing,
  p2pNetworkSelection,
  remoteConnectionsState
} from '@/app/domains/remote-connections'
import RuntimeTabAddMenu from '../components/RuntimeTabAddMenu.vue'
import { runtimeBrowser, resetRuntimeBrowserForTests } from '../runtimeBrowserState'

const serviceId = 'a'.repeat(12)
const pairId = 'b'.repeat(12)
const networkId = 'c'.repeat(12)
const userId = 'd'.repeat(12)
const revision = 'e'.repeat(64)
const computer: P2PComputerView = {
  connectionId: pairId,
  pairId,
  serviceId,
  networkId,
  userId,
  displayName: 'Office computer',
  localDeviceId: '1'.repeat(12),
  remoteDeviceId: pairId,
  localPublicKey: 'local-test-key',
  remotePublicKey: 'remote-test-key',
  pairRevision: 1,
  pairState: 'active'
}
function choices(selected = false): P2PNetworkChoicesView {
  return {
    userId,
    catalogRevision: revision,
    devices: [
      {
        pairId,
        name: 'Office computer',
        selectedNetworkId: selected ? networkId : '',
        state: selected ? 'selected' : 'required',
        choices: [
          { networkId, name: 'Work network' },
          { networkId: 'f'.repeat(12), name: 'Home network' }
        ]
      }
    ]
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
let wrapper: VueWrapper | undefined
async function settle() {
  await nextTick()
  await flushPromises()
  await nextTick()
}
function button(id: string): HTMLButtonElement {
  const value = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
  if (!value) throw Error(`Missing button ${id}`)
  return value
}
async function install() {
  const networkChoices = vi.fn(async () => apiOk(choices()))
  const selectNetwork = vi.fn(async () => apiOk(choices(true)))
  window.dshLauncher = { p2pManagement: { networkChoices, selectNetwork } } as unknown as DesktopApi
  wrapper = mount(RuntimeTabAddMenu, { attachTo: document.body })
  await settle()
  button('runtime-add-tab').click()
  await settle()
  button(`runtime-add-peer-${pairId}`).click()
  await settle()
  return { networkChoices, selectNetwork }
}

beforeEach(() => {
  vi.restoreAllMocks()
  resetRuntimeBrowserForTests()
  remoteConnectionsState.value = { connections: [] }
  p2pManagement.selectedServiceId.value = serviceId
  p2pAccounts.state(serviceId).user = { userId, username: 'test-only@example.test' }
  p2pManagement.catalog.value = {
    revision,
    catalogId: '2'.repeat(12),
    services: [],
    computers: [],
    forgottenServiceIds: []
  }
  Object.assign(p2pNetworkSelection.state(serviceId), {
    view: undefined,
    loading: false,
    readFailed: false,
    pending: '',
    unconfirmed: false,
    error: ''
  })
  vi.spyOn(p2pManagement, 'ensureBuiltinService').mockResolvedValue()
  vi.spyOn(p2pPairing, 'read').mockResolvedValue()
  vi.spyOn(p2pManagement, 'readCatalog').mockImplementation(async () => {
    if (
      p2pNetworkSelection.state(serviceId).view?.devices[0]?.state === 'selected' &&
      p2pManagement.catalog.value
    )
      p2pManagement.catalog.value.computers = [computer]
  })
  vi.spyOn(p2pConnections, 'connect').mockResolvedValue()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  resetRuntimeBrowserForTests()
  vi.restoreAllMocks()
})

describe('add-tab explicit network choice interaction', () => {
  it('shows one computer, no implicit choice, keyboard focus and one authoritative tab after Enter', async () => {
    const f = await install()
    expect(f.selectNetwork).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('runtime-network-back'))
    expect(document.querySelectorAll('[data-testid^="runtime-network-select-"]')).toHaveLength(2)
    const target = button(`runtime-network-select-${networkId}`)
    target.focus()
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
    await settle()
    expect(f.selectNetwork).toHaveBeenCalledTimes(1)
    expect(f.selectNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, pairId, networkId, userId, expectedRevision: revision })
    )
    expect(runtimeBrowser.tabs.value.filter((tab) => tab.id === `peer:${pairId}`)).toHaveLength(1)
    expect(p2pConnections.connect).toHaveBeenCalledExactlyOnceWith(serviceId, pairId)
    expect(document.activeElement).toBe(button('runtime-add-tab'))
  })

  it('restores focus on back/Esc and rejects a late successful result after close', async () => {
    const f = await install()
    button('runtime-network-back').click()
    await settle()
    expect(document.activeElement).toBe(button(`runtime-add-peer-${pairId}`))
    button(`runtime-add-peer-${pairId}`).click()
    await settle()
    const pending = deferred<ReturnType<typeof apiOk<P2PNetworkChoicesView>>>()
    f.selectNetwork.mockReturnValueOnce(pending.promise)
    button(`runtime-network-select-${networkId}`).click()
    await settle()
    expect(button(`runtime-network-select-${networkId}`).disabled).toBe(true)
    button('runtime-add-tab-close').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await settle()
    pending.resolve(apiOk(choices(true)))
    await settle()
    expect(runtimeBrowser.tabs.value.some((tab) => tab.id === `peer:${pairId}`)).toBe(false)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('runtime-add-tab'))
  })

  it('keeps an unknown result blocked until explicit readback without replay or automatic tab opening', async () => {
    const f = await install()
    f.selectNetwork.mockResolvedValueOnce(apiFail('p2p.request_timeout', 'timeout') as never)
    button(`runtime-network-select-${networkId}`).click()
    await settle()
    expect(button(`runtime-network-select-${networkId}`).disabled).toBe(true)
    f.networkChoices.mockResolvedValueOnce(apiOk(choices(true)))
    button('runtime-network-refresh').click()
    await settle()
    expect(f.selectNetwork).toHaveBeenCalledTimes(1)
    expect(runtimeBrowser.tabs.value.some((tab) => tab.id === `peer:${pairId}`)).toBe(false)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })

  it('does not open a tab after the invoking component is unmounted', async () => {
    const f = await install()
    const pending = deferred<ReturnType<typeof apiOk<P2PNetworkChoicesView>>>()
    f.selectNetwork.mockReturnValueOnce(pending.promise)
    button(`runtime-network-select-${networkId}`).click()
    await settle()
    wrapper?.unmount()
    wrapper = undefined
    pending.resolve(apiOk(choices(true)))
    await settle()
    expect(runtimeBrowser.tabs.value.some((tab) => tab.id === `peer:${pairId}`)).toBe(false)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })

  it('does not late-open after Back and re-entering the same computer while its choice is pending', async () => {
    const f = await install()
    const pending = deferred<ReturnType<typeof apiOk<P2PNetworkChoicesView>>>()
    f.selectNetwork.mockReturnValueOnce(pending.promise)
    button(`runtime-network-select-${networkId}`).click()
    await settle()
    button('runtime-network-back').click()
    await settle()
    button(`runtime-add-peer-${pairId}`).click()
    await settle()
    pending.resolve(apiOk(choices(true)))
    await settle()
    expect(runtimeBrowser.tabs.value.some((tab) => tab.id === `peer:${pairId}`)).toBe(false)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
    expect(f.selectNetwork).toHaveBeenCalledTimes(1)
  })

  it('does not open an old account tab when account changes while the choice commits', async () => {
    const f = await install()
    const pending = deferred<ReturnType<typeof apiOk<P2PNetworkChoicesView>>>()
    f.selectNetwork.mockReturnValueOnce(pending.promise)
    button(`runtime-network-select-${networkId}`).click()
    await settle()
    p2pAccounts.state(serviceId).user = null
    pending.resolve(apiOk(choices(true)))
    await settle()
    expect(runtimeBrowser.tabs.value.some((tab) => tab.id === `peer:${pairId}`)).toBe(false)
    expect(p2pConnections.connect).not.toHaveBeenCalled()
  })
})
