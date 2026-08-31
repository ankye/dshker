import type { ApiResult } from '../contracts'
import { bridgeFail, bridgeOk } from '../bridge'
import type {
  ResourceCatalog,
  ResourceRecord,
  VfsBridge,
  VfsEntry,
  VfsRef,
  VfsWebRoute
} from '../vfs'
import { parseVfsWebUrl, toVfsWebUrl } from '../vfs'

export interface VfsServiceRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: unknown
}

export interface VfsServiceResponse {
  status: number
  headers: Record<string, string>
  body?: Uint8Array | string | Record<string, unknown>
}

export interface VfsSignedUrlOptions {
  origin: string
  token: string
  expiresAtMs: number
  route?: VfsWebRoute
}

export interface VfsServiceContext {
  vfs: VfsBridge
  catalog: ResourceCatalog
  authorize?: (request: VfsServiceRequest, ref: VfsRef) => boolean
  nowMs?: () => number
}

export interface VfsServiceRoutePlan {
  method: VfsServiceRequest['method']
  path: string
  capability:
    | 'metadata'
    | 'list'
    | 'read'
    | 'stream'
    | 'download'
    | 'thumbnail'
    | 'import'
    | 'package'
    | 'job-events'
}

export interface VfsBackgroundJob {
  id: string
  kind: 'import' | 'index' | 'parse' | 'thumbnail' | 'package' | 'cleanup'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  resourceId?: string
  message?: string
  updatedAtMs: number
}

export const DEFAULT_VFS_SERVICE_ROUTES: VfsServiceRoutePlan[] = [
  { method: 'GET', path: '/vfs/resource/:root/*path', capability: 'read' },
  { method: 'GET', path: '/vfs/stream/:root/*path', capability: 'stream' },
  { method: 'GET', path: '/vfs/download/:root/*path', capability: 'download' },
  { method: 'GET', path: '/vfs/thumbnail/:root/*path', capability: 'thumbnail' },
  { method: 'GET', path: '/api/resources', capability: 'list' },
  { method: 'GET', path: '/api/resources/:id', capability: 'metadata' },
  { method: 'POST', path: '/api/imports', capability: 'import' },
  { method: 'POST', path: '/api/packages/export', capability: 'package' },
  { method: 'GET', path: '/api/jobs/events', capability: 'job-events' }
]

export function createVfsSignedUrl(ref: VfsRef, options: VfsSignedUrlOptions): ApiResult<string> {
  if (options.expiresAtMs <= 0) {
    return bridgeFail('vfs.invalid_url', 'Signed VFS URL must include an expiration.')
  }
  if (!options.token) {
    return bridgeFail('vfs.invalid_url', 'Signed VFS URL must include a token.')
  }
  return toVfsWebUrl(ref, {
    origin: options.origin,
    route: options.route || 'resource',
    token: options.token,
    expiresAtMs: options.expiresAtMs
  })
}

export async function resolveVfsServiceRequest(
  context: VfsServiceContext,
  request: VfsServiceRequest
): Promise<ApiResult<{ ref: VfsRef; entry: VfsEntry }>> {
  const parsed = parseVfsWebUrl(request.url)
  if (!parsed.ok) return parsed

  if (
    parsed.data.expiresAtMs !== undefined &&
    parsed.data.expiresAtMs < (context.nowMs?.() ?? Date.now())
  ) {
    return bridgeFail('vfs.url_expired', 'Signed VFS URL has expired.')
  }
  if (context.authorize && !context.authorize(request, parsed.data.ref)) {
    return bridgeFail('vfs.permission_denied', 'VFS service request is not authorized.')
  }

  const entry = await context.vfs.stat(parsed.data.ref)
  if (!entry.ok) return entry
  return bridgeOk({ ref: parsed.data.ref, entry: entry.data })
}

export function serializeResourceForWeb(record: ResourceRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    origin: record.origin,
    fingerprint: record.fingerprint,
    size: record.size,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    root: record.root,
    path: record.path,
    uri: record.uri,
    mutable: record.mutable,
    contentType: record.contentType,
    projectId: record.projectId,
    tags: record.tags,
    rating: record.rating,
    colorLabel: record.colorLabel,
    favorite: record.favorite,
    virtualFolders: record.virtualFolders,
    collections: record.collections,
    importBatchId: record.importBatchId,
    derivatives: record.derivatives,
    pluginMetadata: record.pluginMetadata,
    trashedAtMs: record.trashedAtMs
  }
}
