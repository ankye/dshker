import type { ApiResult, DesktopApi } from './contracts'
import type { RepositoryStorage } from './runtime'
import { bridgeFail, bridgeOk, getDesktopApi } from './bridge'
import { unwrapResult } from './errors'

export function assertStorageKey(value: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe storage key: ${value}`)
  }
}

export async function readStorage<T>(
  namespace: string,
  key: string,
  fallback: T,
  api: DesktopApi | undefined = getDesktopApi()
): Promise<T> {
  assertStorageKey(namespace)
  assertStorageKey(key)

  if (!api?.storage) return fallback

  try {
    const value = unwrapResult(await api.storage.read(namespace, key))
    return value === undefined || value === null ? fallback : (value as T)
  } catch {
    return fallback
  }
}

export async function writeStorage(
  namespace: string,
  key: string,
  value: unknown,
  api: DesktopApi | undefined = getDesktopApi()
): Promise<void> {
  assertStorageKey(namespace)
  assertStorageKey(key)

  if (!api?.storage) return
  unwrapResult(await api.storage.write({ namespace, key, value }))
}

export async function removeStorage(
  namespace: string,
  key: string,
  api: DesktopApi | undefined = getDesktopApi()
): Promise<void> {
  assertStorageKey(namespace)
  assertStorageKey(key)

  if (!api?.storage) return
  unwrapResult(await api.storage.remove(namespace, key))
}

export interface SecureStorageAdapter {
  isAvailable(): Promise<ApiResult<boolean>>
  readSecret(namespace: string, key: string): Promise<ApiResult<string | undefined>>
  writeSecret(namespace: string, key: string, value: string): Promise<ApiResult<void>>
  removeSecret(namespace: string, key: string): Promise<ApiResult<void>>
}

export function createBridgeRepositoryStorage(
  api: DesktopApi | undefined = getDesktopApi()
): RepositoryStorage {
  return {
    read: (namespace, key, fallback) => readStorage(namespace, key, fallback, api),
    write: (namespace, key, value) => writeStorage(namespace, key, value, api),
    remove: (namespace, key) => removeStorage(namespace, key, api)
  }
}

export function createBridgeSecureStorageAdapter(
  api: DesktopApi | undefined = getDesktopApi()
): SecureStorageAdapter {
  function unavailable<T>(): ApiResult<T> {
    return bridgeFail('storage.secure_unavailable', 'Secure storage is unavailable.')
  }

  return {
    async isAvailable() {
      if (!api?.secureStorage?.isAvailable) return bridgeOk(false)
      return api.secureStorage.isAvailable()
    },
    async readSecret(namespace, key) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!api?.secureStorage?.readSecret) return unavailable()
      return api.secureStorage.readSecret(namespace, key)
    },
    async writeSecret(namespace, key, value) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!api?.secureStorage?.writeSecret) return unavailable()
      return api.secureStorage.writeSecret({ namespace, key, value })
    },
    async removeSecret(namespace, key) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!api?.secureStorage?.removeSecret) return unavailable()
      return api.secureStorage.removeSecret(namespace, key)
    }
  }
}

export function createMemorySecureStorageAdapter(
  options: {
    available?: boolean
  } = {}
): SecureStorageAdapter {
  const records = new Map<string, string>()
  const available = options.available ?? true
  const keyFor = (namespace: string, key: string) => `${namespace}:${key}`

  function unavailable<T>(): ApiResult<T> {
    return bridgeFail('storage.secure_unavailable', 'Secure storage is unavailable.')
  }

  return {
    async isAvailable() {
      return bridgeOk(available)
    },
    async readSecret(namespace, key) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!available) return unavailable()
      return bridgeOk(records.get(keyFor(namespace, key)))
    },
    async writeSecret(namespace, key, value) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!available) return unavailable()
      records.set(keyFor(namespace, key), value)
      return bridgeOk(undefined)
    },
    async removeSecret(namespace, key) {
      assertStorageKey(namespace)
      assertStorageKey(key)
      if (!available) return unavailable()
      records.delete(keyFor(namespace, key))
      return bridgeOk(undefined)
    }
  }
}

export function createSecureRepositoryStorage(adapter: SecureStorageAdapter): RepositoryStorage {
  return {
    async read(namespace, key, fallback) {
      const result = unwrapResult(await adapter.readSecret(namespace, key))
      if (result === undefined) return fallback
      return JSON.parse(result) as typeof fallback
    },
    async write(namespace, key, value) {
      unwrapResult(await adapter.writeSecret(namespace, key, JSON.stringify(value)))
    },
    async remove(namespace, key) {
      unwrapResult(await adapter.removeSecret(namespace, key))
    }
  }
}
