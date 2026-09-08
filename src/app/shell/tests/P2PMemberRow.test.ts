import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P2PPairView } from '@/shared/p2p-management'
import { p2pConnections, p2pPairing, p2pWorkReconciliation } from '@/app/domains/remote-connections'
import P2PPairingPanel from '../components/P2PPairingPanel.vue'

const serviceId = 'a'.repeat(64)
const networkId = '2'.repeat(32)
const windowsMember: P2PPairView = {
  pairId: '1'.repeat(32),
  networkId,
  state: 'active',
  revision: 1,
  expiresAt: 0,
  initiator: {
    deviceId: '3'.repeat(32),
    userId: '5'.repeat(32),
    name: 'MacBook-Pro',
    fingerprint: '1111 2222 3333 4444 5555 6666 7777 8888',
    presence: 'offline'
  },
  target: {
    deviceId: '4'.repeat(32),
    userId: '5'.repeat(32),
    name: 'Windows-PC',
    fingerprint: 'aaaa bbbb cccc dddd eeee ffff 1111 2222',
    presence: 'offline'
  },
  localIsInitiator: true
}

beforeEach(() => {
  const state = p2pPairing.state(serviceId)
  state.pairs = [windowsMember]
  vi.spyOn(p2pPairing, 'read').mockResolvedValue(undefined)
  vi.spyOn(p2pConnections, 'read').mockResolvedValue(undefined)
  vi.spyOn(p2pConnections, 'find').mockReturnValue(undefined)
  vi.spyOn(p2pConnections, 'isConnecting').mockReturnValue(false)
  vi.spyOn(p2pWorkReconciliation, 'needsAttention').mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  p2pPairing.state(serviceId).pairs = undefined
})

describe('P2P member row', () => {
  it('leads with the member name so the row identifies the computer', () => {
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    expect(wrapper.get('[data-testid="p2p-member-name"]').text()).toBe('Windows-PC')
  })

  it('falls back to the device id when the member has no name', () => {
    const unnamed = {
      ...windowsMember,
      target: { ...windowsMember.target, name: '' }
    }
    p2pPairing.state(serviceId).pairs = [unnamed]
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    expect(wrapper.get('[data-testid="p2p-member-name"]').text()).toBe('4'.repeat(32))
  })

  it('shows the remote device id, never the local one', () => {
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    const id = wrapper.get('.p2p-member-id code').text()
    expect(id).toBe('4'.repeat(32))
  })

  it('describes membership rather than a pairing ceremony', () => {
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    expect(wrapper.text()).not.toContain('配对状态')
  })
})

describe('P2P connect feedback', () => {
  it('shows no connect hint when the last operation ended cleanly', () => {
    const state = p2pPairing.state(serviceId)
    state.pairs = [windowsMember]
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    expect(wrapper.find('[data-testid="p2p-connect-hint"]').exists()).toBe(false)
    state.pairs = undefined
  })

  it('offers opening the workbench instead of connecting when already ready', () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    const state = p2pPairing.state(serviceId)
    state.pairs = [windowsMember]
    const wrapper = mount(P2PPairingPanel, { props: { serviceId, networkId } })
    expect(wrapper.find('[data-testid="p2p-open-workbench"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="p2p-connection-connect"]').exists()).toBe(false)
    state.pairs = undefined
  })
})
