import { describe, expect, it, vi } from 'vitest'
import {
  bridgeFail,
  bridgeOk,
  bridgeValidators,
  callPlatformCapability,
  createPlatformAdapter,
  createPreloadBridge,
  createShellCapabilityRegistry,
  getShellCapability,
  invokeBridge,
  mapBridgeError,
  registerBridgeHandlers,
  requireBridgePermission,
  validateBridgeArgs
} from './bridge'

describe('bridge runtime', () => {
  it('wraps success and redacts unsafe error details', () => {
    expect(bridgeOk({ value: 1 })).toEqual({ ok: true, data: { value: 1 } })
    expect(
      bridgeFail('bridge.handler_failed', 'Failed.', {
        token: 'abc123',
        nested: { authorization: 'secret' }
      })
    ).toEqual({
      ok: false,
      error: {
        code: 'bridge.handler_failed',
        message: 'Failed.',
        details: {
          token: '[redacted]',
          nested: { authorization: '[redacted]' }
        }
      }
    })
  })

  it('checks permissions and validates payloads', () => {
    expect(requireBridgePermission(['settings:read'], 'settings:read').ok).toBe(true)
    expect(requireBridgePermission(['settings:read'], 'settings:write')).toMatchObject({
      ok: false,
      error: { code: 'bridge.permission_denied' }
    })
    expect(validateBridgeArgs(['settings'], [bridgeValidators.nonEmptyString]).ok).toBe(true)
    expect(validateBridgeArgs([0], [bridgeValidators.string])).toMatchObject({
      ok: false,
      error: { code: 'bridge.invalid_payload' }
    })
  })

  it('exposes preload shape through a caller-provided bridge', () => {
    const expose = vi.fn()
    const api = { ping: () => 'pong' }

    expect(createPreloadBridge(api, expose)).toBe(api)
    expect(expose).toHaveBeenCalledWith('desktopApi', api)
  })

  it('invokes and registers handlers with success and failure mapping', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    registerBridgeHandlers(
      (channel, handler) => handlers.set(channel, handler),
      [
        {
          channel: 'settings:load',
          permission: 'settings:read',
          validate: [bridgeValidators.nonEmptyString],
          handle: (scope) => ({ scope })
        },
        {
          channel: 'settings:save',
          permission: 'settings:write',
          handle: () => {
            throw new Error('disk unavailable')
          }
        }
      ],
      { permissions: ['settings:read'] }
    )

    await expect(handlers.get('settings:load')?.('user')).resolves.toEqual({
      ok: true,
      data: { scope: 'user' }
    })
    await expect(handlers.get('settings:load')?.(0)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bridge.invalid_payload' }
    })
    await expect(handlers.get('settings:save')?.()).resolves.toMatchObject({
      ok: false,
      error: { code: 'bridge.permission_denied' }
    })

    await expect(
      invokeBridge<{ scope: string }>(
        async (channel, ...args) => handlers.get(channel)?.(...args),
        'settings:load',
        'user'
      )
    ).resolves.toEqual({
      ok: true,
      data: { scope: 'user' }
    })
  })

  it('maps typed and unknown bridge errors safely', () => {
    expect(
      mapBridgeError({
        code: 'settings.load_failed',
        message: 'Unable to load settings.',
        details: { apiKey: 'secret' }
      })
    ).toEqual({
      ok: false,
      error: {
        code: 'settings.load_failed',
        message: 'Unable to load settings.',
        details: { apiKey: '[redacted]' }
      }
    })
    expect(mapBridgeError(new Error('boom'))).toMatchObject({
      ok: false,
      error: { code: 'bridge.handler_failed', message: 'boom' }
    })
  })

  it('builds a platform capability registry and reports unsupported capabilities', () => {
    const capabilities = createShellCapabilityRegistry('win32')
    expect(getShellCapability(capabilities, 'windows')).toMatchObject({
      ok: true,
      data: { id: 'windows', supported: true }
    })
    expect(getShellCapability(capabilities, 'title-bar')).toMatchObject({
      ok: true,
      data: {
        id: 'title-bar',
        bridgeMethod: 'shell.setTitleBarTheme',
        supported: true
      }
    })
    expect(getShellCapability(capabilities, 'missing')).toMatchObject({
      ok: false,
      error: { code: 'bridge.unsupported_capability' }
    })
    expect(getShellCapability(capabilities, 'menu-bar')).toMatchObject({
      ok: true,
      data: { supported: false }
    })
  })

  it('routes native work through the platform adapter boundary', async () => {
    const adapter = createPlatformAdapter('win32')

    await expect(callPlatformCapability(adapter, 'clipboard', () => 'copied')).resolves.toEqual({
      ok: true,
      data: 'copied'
    })
    await expect(
      callPlatformCapability(adapter, 'menu-bar', () => 'ignored')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'bridge.unsupported_capability' }
    })
  })
})
