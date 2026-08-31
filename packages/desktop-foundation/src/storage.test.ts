import { describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from './contracts'
import { createJsonRepository, defineValidator } from './runtime'
import {
  assertStorageKey,
  createBridgeSecureStorageAdapter,
  createMemorySecureStorageAdapter,
  createSecureRepositoryStorage,
  readStorage,
  removeStorage,
  writeStorage
} from './storage'

interface SecretRecord {
  id: string
  value: string
}

const secretValidator = defineValidator<SecretRecord>(
  (value): value is SecretRecord =>
    Boolean(
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'value' in value &&
      typeof value.value === 'string'
    ),
  'Invalid secret record.'
)

function apiWithStorage(): DesktopApi {
  return {
    app: {
      getInfo: vi.fn()
    },
    shell: {
      getCapabilities: vi.fn(),
      getCapability: vi.fn()
    },
    settings: {
      load: vi.fn(),
      save: vi.fn(),
      reset: vi.fn()
    },
    storage: {
      read: vi.fn(async () => ({ ok: true as const, data: { value: 42 } })),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
      remove: vi.fn(async () => ({ ok: true as const, data: undefined }))
    },
    diagnostics: {
      log: vi.fn()
    }
  }
}

describe('storage foundation', () => {
  it('rejects unsafe storage keys', () => {
    expect(() => assertStorageKey('../bad')).toThrow('Unsafe storage key')
  })

  it('routes read, write, and remove through the bridge API', async () => {
    const api = apiWithStorage()

    await expect(readStorage('prefs', 'layout', null, api)).resolves.toEqual({
      value: 42
    })
    await writeStorage('prefs', 'layout', { value: 1 }, api)
    await removeStorage('prefs', 'layout', api)

    expect(api.storage.read).toHaveBeenCalledWith('prefs', 'layout')
    expect(api.storage.write).toHaveBeenCalledWith({
      namespace: 'prefs',
      key: 'layout',
      value: { value: 1 }
    })
    expect(api.storage.remove).toHaveBeenCalledWith('prefs', 'layout')
  })

  it('maps unavailable bridge secure storage to typed errors', async () => {
    const adapter = createBridgeSecureStorageAdapter(undefined)

    await expect(adapter.isAvailable()).resolves.toEqual({
      ok: true,
      data: false
    })
    await expect(adapter.readSecret('secrets', 'token')).resolves.toMatchObject({
      ok: false,
      error: { code: 'storage.secure_unavailable' }
    })
  })

  it('backs repositories with secure storage adapters', async () => {
    const adapter = createMemorySecureStorageAdapter()
    const repository = createJsonRepository({
      namespace: 'secrets',
      storage: createSecureRepositoryStorage(adapter),
      validate: secretValidator,
      version: 1
    })

    await expect(repository.save({ id: 'token', value: 'secret-value' })).resolves.toEqual({
      ok: true,
      data: { id: 'token', value: 'secret-value' }
    })
    await expect(repository.get('token')).resolves.toEqual({
      ok: true,
      data: { id: 'token', value: 'secret-value' }
    })
  })
})
