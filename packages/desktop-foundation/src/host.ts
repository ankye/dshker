import type { ApiResult, DesktopApi } from './contracts'
import { bridgeFail, bridgeOk, getDesktopApi } from './bridge'
import type { ResourceCatalogFilter, ResourceRecord, VfsPage, VfsRef, VfsWebRoute } from './vfs'
import { toVfsWebUrl } from './vfs'

export type DesktopHostKind = 'electron' | 'web' | 'node-service'
export type AssetAccessMode = 'bridge' | 'web-service' | 'service-local'
export type NavigationMode = 'hash' | 'history'

export interface DesktopHostInfo {
  kind: DesktopHostKind
  bridgeAvailable: boolean
  assetAccessMode: AssetAccessMode
  location?: string
}

export interface WebAssetServiceClientOptions {
  baseUrl: string
  token?: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

export interface WebAssetRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
}

export interface WebAssetUrlOptions {
  route?: VfsWebRoute
  token?: string
  expiresAtMs?: number
}

export interface WebAssetServiceClient {
  readonly baseUrl: string
  request<T>(path: string, options?: WebAssetRequestOptions): Promise<ApiResult<T>>
  listResources(filter?: ResourceCatalogFilter): Promise<ApiResult<VfsPage<ResourceRecord>>>
  getResource(id: string): Promise<ApiResult<ResourceRecord>>
  createResourceUrl(ref: VfsRef, options?: WebAssetUrlOptions): ApiResult<string>
}

export function detectDesktopHost(
  api: DesktopApi | null | undefined = getDesktopApi(),
  location: string | undefined = typeof window === 'undefined' ? undefined : window.location.href
): DesktopHostInfo {
  const bridgeAvailable = Boolean(api)
  const runningInBrowser = typeof window !== 'undefined'

  if (!runningInBrowser) {
    return {
      kind: 'node-service',
      bridgeAvailable: false,
      assetAccessMode: 'service-local',
      location
    }
  }

  return {
    kind: bridgeAvailable ? 'electron' : 'web',
    bridgeAvailable,
    assetAccessMode: bridgeAvailable ? 'bridge' : 'web-service',
    location
  }
}

export function selectNavigationMode(host: DesktopHostInfo): NavigationMode {
  return host.kind === 'web' ? 'history' : 'hash'
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function buildUrl(baseUrl: string, requestPath: string, query?: WebAssetRequestOptions['query']) {
  const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  const url = new URL(`${baseUrl}${normalizedPath}`)

  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function toWebAssetQuery(filter: ResourceCatalogFilter): WebAssetRequestOptions['query'] {
  const query: Record<string, string | number | boolean | undefined> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      query[key] = value
    }
  }
  return query
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()
  return response.text()
}

function unwrapServiceBody<T>(body: unknown): ApiResult<T> {
  if (body && typeof body === 'object' && 'ok' in body) return body as ApiResult<T>
  return bridgeOk(body as T)
}

export function createWebAssetServiceClient(
  options: WebAssetServiceClientOptions
): WebAssetServiceClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl || fetch

  if (!baseUrl) {
    throw new Error('Web asset service baseUrl is required.')
  }

  async function request<T>(
    requestPath: string,
    requestOptions: WebAssetRequestOptions = {}
  ): Promise<ApiResult<T>> {
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(options.headers || {}),
        ...(requestOptions.headers || {})
      }
      if (options.token) headers.authorization = `Bearer ${options.token}`
      if (requestOptions.body !== undefined) headers['content-type'] = 'application/json'

      const response = await fetchImpl(buildUrl(baseUrl, requestPath, requestOptions.query), {
        method: requestOptions.method || 'GET',
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body)
      })
      const body = await readResponseBody(response)

      if (!response.ok) {
        return bridgeFail('web_asset_service.request_failed', 'Web asset service request failed.', {
          status: response.status,
          path: requestPath,
          body
        })
      }

      return unwrapServiceBody<T>(body)
    } catch (error) {
      return bridgeFail(
        'web_asset_service.unavailable',
        'Web asset service is unavailable.',
        error instanceof Error ? { message: error.message } : error
      )
    }
  }

  return {
    baseUrl,
    request,
    listResources(filter = {}) {
      return request<VfsPage<ResourceRecord>>('/api/resources', {
        query: toWebAssetQuery(filter)
      })
    },
    getResource(id) {
      return request<ResourceRecord>(`/api/resources/${encodeURIComponent(id)}`)
    },
    createResourceUrl(ref, urlOptions = {}) {
      return toVfsWebUrl(ref, {
        origin: baseUrl,
        route: urlOptions.route || 'resource',
        token: urlOptions.token || options.token,
        expiresAtMs: urlOptions.expiresAtMs
      })
    }
  }
}
