import { describe, expect, it, vi } from 'vitest'
import { createWebAssetServiceClient, detectDesktopHost, selectNavigationMode } from './host'

describe('desktop host runtime', () => {
  it('detects web, electron, and node-service host modes', () => {
    const webHost = detectDesktopHost(null, 'https://share.example.test/assets')
    expect(webHost).toMatchObject({
      kind: 'web',
      bridgeAvailable: false,
      assetAccessMode: 'web-service'
    })
    expect(selectNavigationMode(webHost)).toBe('history')

    const electronHost = detectDesktopHost({ app: {} } as never, 'app://desktop/index.html')
    expect(electronHost).toMatchObject({
      kind: 'electron',
      bridgeAvailable: true,
      assetAccessMode: 'bridge'
    })
    expect(selectNavigationMode(electronHost)).toBe('hash')

    const originalWindow = globalThis.window
    Reflect.deleteProperty(globalThis, 'window')
    try {
      const nodeHost = detectDesktopHost(undefined, undefined)
      expect(nodeHost).toMatchObject({
        kind: 'node-service',
        bridgeAvailable: false,
        assetAccessMode: 'service-local'
      })
      expect(selectNavigationMode(nodeHost)).toBe('hash')
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true
      })
    }
  })

  it('calls a web asset service and creates safe resource URLs', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            items: [{ id: 'imports:hero.png', path: 'hero.png' }],
            nextCursor: '1',
            total: 1
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const client = createWebAssetServiceClient({
      baseUrl: 'https://assets.example.test/',
      token: 'share-token',
      fetchImpl: fetchImpl as never
    })

    await expect(client.listResources({ tag: 'hero', limit: 25 })).resolves.toMatchObject({
      ok: true,
      data: {
        items: [{ id: 'imports:hero.png' }],
        total: 1
      }
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://assets.example.test/api/resources?tag=hero&limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer share-token'
        })
      })
    )

    expect(
      client.createResourceUrl(
        { root: 'imports', path: 'library/hero.png' },
        { route: 'thumbnail', expiresAtMs: 5000 }
      )
    ).toEqual({
      ok: true,
      data: 'https://assets.example.test/vfs/thumbnail/imports/library/hero.png?token=share-token&expiresAtMs=5000'
    })
  })
})
