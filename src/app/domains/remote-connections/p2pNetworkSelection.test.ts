import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { P2PNetworkSelectionDomain } from './p2pNetworkSelection'
import { P2PManagementDomain } from './p2pManagement'
import type { DesktopApi } from '@/shared/contracts'
import type { P2PManagementApi, P2PNetworkChoicesView } from '@/shared/p2p-management'

const serviceId = 'a'.repeat(12)
const pairId = 'b'.repeat(12)
const networkId = 'c'.repeat(12)
const userId = 'd'.repeat(12)
const revision = 'e'.repeat(64)
function view(): P2PNetworkChoicesView {
  return {
    userId,
    catalogRevision: revision,
    devices: [
      {
        pairId,
        name: 'Computer',
        selectedNetworkId: '',
        state: 'required',
        choices: [
          { networkId, name: 'Work' },
          { networkId: 'f'.repeat(12), name: 'Home' }
        ]
      }
    ]
  }
}
function fixture() {
  let catalogListener: ((event: { serviceId: string; revision: string }) => void) | undefined
  const networkChoices = vi.fn(async () => ({ ok: true as const, data: view() }))
  const selectNetwork = vi.fn(async () => ({
    ok: true as const,
    data: {
      ...view(),
      devices: view().devices.map((device) => ({
        ...device,
        state: 'selected' as const,
        selectedNetworkId: networkId
      }))
    } as P2PNetworkChoicesView
  }))
  const api = {
    networkChoices,
    selectNetwork,
    onCatalogChange: (listener: typeof catalogListener) => {
      catalogListener = listener
      return () => {
        catalogListener = undefined
      }
    }
  } as unknown as P2PManagementApi
  const management = new P2PManagementDomain(() => api)
  vi.spyOn(management, 'readCatalog').mockResolvedValue()
  return {
    domain: new P2PNetworkSelectionDomain(management),
    api,
    networkChoices,
    selectNetwork,
    management,
    fireCatalogChange: (event: { serviceId: string; revision: string }) => catalogListener?.(event)
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('explicit computer network choice', () => {
  it('refreshes choices for the active service when another device invalidates the catalog', async () => {
    const f = fixture()
    const previous = window.dshLauncher
    window.dshLauncher = { p2pManagement: f.api } as unknown as DesktopApi
    try {
      f.domain.subscribe(serviceId)
      f.fireCatalogChange({ serviceId: 'other-service', revision })
      await flushPromises()
      expect(f.networkChoices).not.toHaveBeenCalled()

      f.fireCatalogChange({ serviceId, revision })
      await flushPromises()
      expect(f.networkChoices).toHaveBeenCalledTimes(1)
      expect(f.domain.state(serviceId).view?.devices[0].choices).toHaveLength(2)

      f.domain.stop()
      f.fireCatalogChange({ serviceId, revision })
      await flushPromises()
      expect(f.networkChoices).toHaveBeenCalledTimes(1)
    } finally {
      window.dshLauncher = previous
    }
  })

  it('reads without picking a network and submits only the exact account/revision chosen by the user', async () => {
    const f = fixture()
    await f.domain.read(serviceId)
    expect(f.selectNetwork).not.toHaveBeenCalled()
    expect(f.domain.state(serviceId).view?.devices[0].selectedNetworkId).toBe('')
    expect(await f.domain.select(serviceId, pairId, networkId)).toBe(true)
    expect(f.selectNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, pairId, networkId, userId, expectedRevision: revision })
    )
    expect(f.domain.state(serviceId).view?.devices[0].selectedNetworkId).toBe(networkId)
  })

  it('blocks repeated submissions while pending and refuses late results superseded by a fresh account read', async () => {
    const f = fixture()
    await f.domain.read(serviceId)
    const pending = deferred<Awaited<ReturnType<typeof f.selectNetwork>>>()
    f.selectNetwork.mockReturnValueOnce(pending.promise)
    const first = f.domain.select(serviceId, pairId, networkId)
    expect(await f.domain.select(serviceId, pairId, 'f'.repeat(12))).toBe(false)
    f.networkChoices.mockResolvedValueOnce({
      ok: true,
      data: { ...view(), userId: '1'.repeat(12) }
    })
    await f.domain.read(serviceId)
    pending.resolve({ ok: true, data: view() })
    expect(await first).toBe(false)
    expect(f.domain.state(serviceId).view?.userId).toBe('1'.repeat(12))
    expect(f.selectNetwork).toHaveBeenCalledTimes(1)
  })

  it('retains unknown outcomes until readback and never replays a write as retry', async () => {
    const f = fixture()
    await f.domain.read(serviceId)
    f.selectNetwork.mockResolvedValueOnce({ ok: false, code: 'p2p.request_timeout' } as never)
    expect(await f.domain.select(serviceId, pairId, networkId)).toBe(false)
    expect(f.domain.state(serviceId).unconfirmed).toBe(true)
    expect(await f.domain.select(serviceId, pairId, networkId)).toBe(false)
    await f.domain.read(serviceId)
    expect(f.selectNetwork).toHaveBeenCalledTimes(1)
    expect(f.domain.state(serviceId).unconfirmed).toBe(false)
  })

  it('keeps a failed refresh visible and blocks commits from its stale choices', async () => {
    const f = fixture()
    await f.domain.read(serviceId)
    const original = f.domain.state(serviceId).view
    f.networkChoices.mockResolvedValueOnce({ ok: false, code: 'p2p.server_unavailable' } as never)
    await f.domain.read(serviceId)
    expect(f.domain.state(serviceId).view).toEqual(original)
    expect(f.domain.state(serviceId).readFailed).toBe(true)
    expect(await f.domain.select(serviceId, pairId, networkId)).toBe(false)
    expect(f.selectNetwork).not.toHaveBeenCalled()
  })

  it('clears old account choices and rejects an in-flight read after invalidation', async () => {
    const f = fixture()
    await f.domain.read(serviceId)
    const pending = deferred<Awaited<ReturnType<typeof f.networkChoices>>>()
    f.networkChoices.mockReturnValueOnce(pending.promise)
    const read = f.domain.read(serviceId)
    f.domain.invalidate(serviceId)
    pending.resolve({ ok: true, data: view() })
    await read
    expect(f.domain.state(serviceId).view).toBeUndefined()
    expect(await f.domain.select(serviceId, pairId, networkId)).toBe(false)
    expect(f.selectNetwork).not.toHaveBeenCalled()
  })
})
