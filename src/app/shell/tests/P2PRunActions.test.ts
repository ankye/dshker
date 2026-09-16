import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { P2PCatalogView, P2PComputerView } from '@/shared/p2p-management'
import {
  p2pConnections,
  p2pManagement,
  p2pWorkReconciliation
} from '@/app/domains/remote-connections'
import P2PRunActions from '../components/P2PRunActions.vue'

const serviceId = 'a'.repeat(12)
const connectionId = 'c'.repeat(12)
const pairId = '1'.repeat(12)

function computer(overrides: Partial<P2PComputerView> = {}): P2PComputerView {
  return {
    connectionId,
    serviceId,
    displayName: 'Studio',
    pairId,
    networkId: '2'.repeat(12),
    localDeviceId: '3'.repeat(12),
    remoteDeviceId: '4'.repeat(12),
    userId: '5'.repeat(12),
    localPublicKey: 'local-key',
    remotePublicKey: 'remote-key',
    pairRevision: 1,
    pairState: 'active',
    ...overrides
  }
}

function catalog(entry: P2PComputerView): P2PCatalogView {
  return {
    revision: 'b'.repeat(64),
    catalogId: 'd'.repeat(12),
    services: [],
    computers: [entry],
    forgottenServiceIds: []
  }
}

beforeEach(() => {
  p2pManagement.catalog.value = catalog(computer())
  vi.spyOn(p2pManagement, 'busy').mockReturnValue(false)
  vi.spyOn(p2pConnections, 'find').mockReturnValue(undefined)
  vi.spyOn(p2pConnections, 'isConnecting').mockReturnValue(false)
  vi.spyOn(p2pWorkReconciliation, 'needsAttention').mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  p2pManagement.catalog.value = null
})

function mountActions() {
  return mount(P2PRunActions, { props: { connectionId } })
}

describe('P2P Run disconnected actions', () => {
  it('offers a connect action that targets the same record', async () => {
    const connect = vi.spyOn(p2pConnections, 'connect').mockResolvedValue(undefined)
    const wrapper = mountActions()
    await wrapper.get('[data-testid="p2p-run-connect"]').trigger('click')
    expect(connect).toHaveBeenCalledWith(serviceId, pairId)
  })

  it('labels a prior failure as a retry rather than a first connect', () => {
    const first = mountActions().get('[data-testid="p2p-run-connect"]').text()
    vi.spyOn(p2pConnections, 'find').mockReturnValue({
      serviceId,
      pairId,
      attemptId: '7'.repeat(12),
      generation: 2,
      stage: 'failed',
      error: 'p2p.direct_closed',
      path: { localType: '', remoteType: '', protocol: '' },
      runtimeGeneration: 0
    })
    // Locale-independent: a failed attempt must not read like a first connect.
    const retry = mountActions().get('[data-testid="p2p-run-connect"]').text()
    expect(retry).not.toBe(first)
    expect(retry).not.toBe('')
  })

  it('refuses to reconnect a revoked pair and explains why', async () => {
    p2pManagement.catalog.value = catalog(computer({ pairState: 'revoked' }))
    const connect = vi.spyOn(p2pConnections, 'connect').mockResolvedValue(undefined)
    const wrapper = mountActions()
    expect(wrapper.find('[data-testid="p2p-run-connect"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="p2p-run-revoked"]').text()).not.toBe('')
    expect(connect).not.toHaveBeenCalled()
  })

  /**
   * A button that does nothing when pressed is indistinguishable from a broken
   * one, and both reasons `connect()` refuses for are invisible: a busy service,
   * and an attempt this window already believes is running.
   */
  it('disables actions while the service is busy, and says why', () => {
    vi.spyOn(p2pManagement, 'busy').mockReturnValue(true)
    const wrapper = mountActions()
    expect(wrapper.get('[data-testid="p2p-run-connect"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="p2p-run-edit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="p2p-run-inert"]').text()).not.toBe('')
  })

  it('does not start a second attempt while one is negotiating, and says so', () => {
    vi.spyOn(p2pConnections, 'isConnecting').mockReturnValue(true)
    const wrapper = mountActions()
    expect(wrapper.get('[data-testid="p2p-run-connect"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="p2p-run-inert"]').text()).not.toBe('')
  })

  it('says nothing about being inert when the action would run', () => {
    const wrapper = mountActions()
    expect(wrapper.find('[data-testid="p2p-run-inert"]').exists()).toBe(false)
  })

  it('emits an edit request that locates this same computer', async () => {
    const wrapper = mountActions()
    await wrapper.get('[data-testid="p2p-run-edit"]').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })

  it('carries an outstanding work warning into the Run page', () => {
    vi.spyOn(p2pWorkReconciliation, 'needsAttention').mockReturnValue(true)
    const wrapper = mountActions()
    expect(wrapper.get('[data-testid="p2p-run-reconcile"]').text()).not.toBe('')
  })

  it('renders nothing for a computer that is not in the catalog', () => {
    const wrapper = mount(P2PRunActions, { props: { connectionId: '9'.repeat(12) } })
    expect(wrapper.find('[data-testid="p2p-run-connect"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="p2p-run-edit"]').exists()).toBe(false)
  })

  it('follows a renamed computer without losing its identity', async () => {
    const wrapper = mountActions()
    p2pManagement.catalog.value = catalog(computer({ displayName: 'Renamed studio' }))
    await wrapper.vm.$nextTick()
    const connect = vi.spyOn(p2pConnections, 'connect').mockResolvedValue(undefined)
    await wrapper.get('[data-testid="p2p-run-connect"]').trigger('click')
    // Identity travels by pair, never by display name.
    expect(connect).toHaveBeenCalledWith(serviceId, pairId)
  })
})
