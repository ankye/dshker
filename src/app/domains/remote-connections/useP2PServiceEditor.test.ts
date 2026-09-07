import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { P2PCatalogView, P2PServiceView } from '@/shared/p2p-management'
import { p2pManagement } from './p2pManagement'
import { p2pServiceEditor as editor } from './useP2PServiceEditor'

const serviceId = 'a'.repeat(64)
const revision = 'b'.repeat(64)
const service: P2PServiceView = {
  serviceId,
  publicKey: 'public-key',
  displayName: 'Home',
  httpsOrigin: 'https://peer.example',
  wssUrl: 'wss://peer.example/v1/signals',
  stunAddress: 'peer.example:3478'
}
const moved: P2PServiceView = {
  ...service,
  httpsOrigin: 'https://moved.example',
  wssUrl: 'wss://moved.example/v1/signals',
  stunAddress: 'moved.example:3478'
}
const catalog = (entry: P2PServiceView, rev = 'c'.repeat(64)): P2PCatalogView => ({
  revision: rev,
  catalogId: 'd'.repeat(32),
  services: [entry],
  computers: [],
  forgottenServiceIds: []
})

let run: ReturnType<typeof vi.fn>

beforeEach(() => {
  editor.clear()
  editor.acknowledgeReadback(service, revision)
  editor.clear()
  run = vi.fn()
  vi.spyOn(p2pManagement, 'run').mockImplementation(run as never)
  vi.spyOn(p2pManagement, 'busy').mockReturnValue(false)
})

describe('P2P shared service editor', () => {
  it('prefills every public endpoint field and no secret', () => {
    editor.open(service, revision)
    expect(editor.draft.value).toEqual({
      displayName: service.displayName,
      httpsOrigin: service.httpsOrigin,
      wssUrl: service.wssUrl,
      stunAddress: service.stunAddress
    })
    expect(JSON.stringify(editor.draft.value)).not.toContain('public-key')
  })

  it('reports dirty only after a real field change', () => {
    editor.open(service, revision)
    expect(editor.dirty.value).toBe(false)
    editor.draft.value!.httpsOrigin = 'https://moved.example'
    expect(editor.dirty.value).toBe(true)
  })

  it('does not dispatch a save when nothing changed', async () => {
    editor.open(service, revision)
    expect(await editor.save()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses to save while the service is busy', async () => {
    vi.spyOn(p2pManagement, 'busy').mockReturnValue(true)
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    expect(editor.canSave.value).toBe(false)
    expect(await editor.save()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('sends the expected revision so a stale write cannot win', async () => {
    run.mockResolvedValue({ ok: true, data: catalog(moved) })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    await editor.save()
    expect(run).toHaveBeenCalledWith(
      'updateServiceConfig',
      expect.objectContaining({ serviceId, revision })
    )
  })

  it('adopts the saved record and the new revision after success', async () => {
    run.mockResolvedValue({ ok: true, data: catalog(moved, 'e'.repeat(64)) })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    editor.draft.value!.wssUrl = moved.wssUrl
    editor.draft.value!.stunAddress = moved.stunAddress
    expect(await editor.save()).toBe(true)
    expect(editor.revision.value).toBe('e'.repeat(64))
    expect(editor.dirty.value).toBe(false)
  })

  it('keeps the input and flags a conflict when the revision is stale', async () => {
    run.mockResolvedValue({ ok: false, code: 'p2p.catalog_conflict', message: 'stale' })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    expect(await editor.save()).toBe(false)
    expect(editor.conflict.value).toBe(true)
    // Input is preserved so the user does not retype it.
    expect(editor.draft.value?.httpsOrigin).toBe(moved.httpsOrigin)
    expect(editor.resultUnconfirmed.value).toBe(false)
  })

  it('keeps the input when a peer is busy and does not mark the result unknown', async () => {
    run.mockResolvedValue({ ok: false, code: 'p2p.service_busy', message: 'busy' })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    expect(await editor.save()).toBe(false)
    expect(editor.resultUnconfirmed.value).toBe(false)
    expect(editor.draft.value?.httpsOrigin).toBe(moved.httpsOrigin)
  })

  it('blocks another save after an outcome that may have taken effect', async () => {
    run.mockResolvedValue({ ok: false, code: 'p2p.server_unavailable', message: 'unknown' })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    await editor.save()
    expect(editor.resultUnconfirmed.value).toBe(true)
    expect(editor.canSave.value).toBe(false)
    expect(await editor.save()).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets a readback clear an unknown outcome', async () => {
    run.mockResolvedValue({ ok: false, code: 'p2p.server_unavailable', message: 'unknown' })
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    await editor.save()
    editor.acknowledgeReadback(moved, 'f'.repeat(64))
    expect(editor.resultUnconfirmed.value).toBe(false)
  })

  it('asks before discarding a dirty draft when switching service', () => {
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    const other = { ...service, serviceId: '9'.repeat(64) }
    expect(editor.open(other, revision)).toBe(false)
    expect(editor.discardRequested.value).toBe(true)
    // Keeping the draft leaves the original target loaded.
    editor.keep()
    expect(editor.original.value?.serviceId).toBe(serviceId)
  })

  it('asks before closing a dirty draft and keeps it on refusal', () => {
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    expect(editor.close()).toBe(false)
    expect(editor.draft.value?.httpsOrigin).toBe(moved.httpsOrigin)
    editor.keep()
    expect(editor.discardRequested.value).toBe(false)
  })

  it('closes cleanly when the draft is unchanged', () => {
    editor.open(service, revision)
    expect(editor.close()).toBe(true)
    expect(editor.draft.value).toBeUndefined()
  })

  it('tracks a newer revision without discarding an in-progress draft', () => {
    editor.open(service, revision)
    editor.draft.value!.httpsOrigin = moved.httpsOrigin
    expect(editor.open(service, 'a'.repeat(63) + 'c')).toBe(true)
    expect(editor.draft.value?.httpsOrigin).toBe(moved.httpsOrigin)
    expect(editor.revision.value).toBe('a'.repeat(63) + 'c')
  })
})
