import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { P2PCatalogView, P2PComputerView } from '@/shared/p2p-management'
import { p2pConnections, p2pManagement } from '@/app/domains/remote-connections'
import { runtimeBrowser } from '../runtimeBrowserState'

const serviceId = 'a'.repeat(64)
const connectionId = 'c'.repeat(32)
const pairId = '1'.repeat(32)

function computer(overrides: Partial<P2PComputerView> = {}): P2PComputerView {
  return {
    connectionId,
    serviceId,
    displayName: 'Studio',
    pairId,
    networkId: '2'.repeat(32),
    localDeviceId: '3'.repeat(32),
    remoteDeviceId: '4'.repeat(32),
    userId: '5'.repeat(32),
    localPublicKey: 'local-key',
    remotePublicKey: 'remote-key',
    pairRevision: 1,
    pairState: 'active',
    ...overrides
  }
}

function catalog(entries: P2PComputerView[]): P2PCatalogView {
  return {
    revision: 'b'.repeat(64),
    catalogId: 'd'.repeat(32),
    services: [],
    computers: entries,
    forgottenServiceIds: []
  }
}

function peerTab() {
  return runtimeBrowser.tabs.value.find((tab) => tab.id === `peer:${connectionId}`)
}

beforeEach(() => {
  p2pManagement.catalog.value = catalog([computer()])
  vi.spyOn(p2pConnections, 'isReady').mockReturnValue(false)
})

afterEach(async () => {
  vi.restoreAllMocks()
  p2pManagement.catalog.value = null
  runtimeBrowser.activeTabId.value = 'local'
  await nextTick()
})

describe('paired computer Run tabs', () => {
  it('creates one fixed tab per paired computer', () => {
    expect(peerTab()).toMatchObject({ source: 'peer', connectionId, title: 'Studio' })
  })

  it('carries no address while the peer is not connected', () => {
    expect(peerTab()?.url).toBeUndefined()
  })

  it('never carries an address for a revoked pair', async () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    p2pManagement.catalog.value = catalog([computer({ pairState: 'revoked' })])
    await nextTick()
    // Revoked keeps its tab so the user sees why, but it must not load.
    expect(peerTab()).toBeDefined()
    expect(peerTab()?.url).toBeUndefined()
  })

  it('keeps the DSH entry point out of tab state even when ready', () => {
    vi.spyOn(p2pConnections, 'isReady').mockReturnValue(true)
    expect(JSON.stringify(peerTab())).not.toMatch(/127\.0\.0\.1|token/i)
  })

  it('follows a rename without changing tab identity', async () => {
    const before = peerTab()?.id
    p2pManagement.catalog.value = catalog([computer({ displayName: 'Renamed studio' })])
    await nextTick()
    expect(peerTab()?.id).toBe(before)
    expect(peerTab()?.title).toBe('Renamed studio')
  })

  it('removes the tab when the computer leaves the catalog', async () => {
    p2pManagement.catalog.value = catalog([])
    await nextTick()
    expect(peerTab()).toBeUndefined()
  })

  it('falls back to the local tab when the active peer disappears', async () => {
    runtimeBrowser.activeTabId.value = `peer:${connectionId}`
    await nextTick()
    p2pManagement.catalog.value = catalog([])
    await nextTick()
    expect(runtimeBrowser.activeTabId.value).toBe('local')
  })

  it('keeps SSH and local tabs intact alongside peers', () => {
    const ids = runtimeBrowser.tabs.value.map((tab) => tab.id)
    expect(ids).toContain('local')
    expect(ids.filter((id) => id.startsWith('peer:'))).toHaveLength(1)
  })
})
