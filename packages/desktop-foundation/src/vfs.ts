import type { ApiResult } from './contracts'
import type { RepositoryStorage } from './runtime'
import { bridgeFail, bridgeOk } from './bridge'

export type VfsRootId =
  | 'app-data'
  | 'projects'
  | 'imports'
  | 'assets'
  | 'cache'
  | 'logs'
  | 'tmp'
  | 'exports'

export type VfsOperation =
  | 'read'
  | 'write'
  | 'delete'
  | 'list'
  | 'stat'
  | 'mkdir'
  | 'copy'
  | 'move'
  | 'import'
  | 'export'
  | 'package'
  | 'cleanup'

export interface VfsRoot {
  id: VfsRootId
  path: string
  mutable: boolean
  cleanup?: 'never' | 'cache' | 'tmp' | 'logs'
  caseSensitive?: boolean
  maxFileBytes?: number
  allowedExtensions?: string[]
}

export type VfsRootMap = Record<VfsRootId, VfsRoot>

export interface VfsPolicy {
  permissions?: Partial<Record<VfsRootId, VfsOperation[]>>
  maxFileBytes?: Partial<Record<VfsRootId, number>>
}

export interface VfsRef {
  root: VfsRootId
  path: string
}

export interface ResolvedVfsPath extends VfsRef {
  fullPath: string
  segments: string[]
  mutable: boolean
}

export interface VfsEntry {
  ref: VfsRef
  uri: string
  fullPath: string
  size: number
  createdAtMs: number
  updatedAtMs: number
  type: 'file' | 'directory'
  contentType?: string
}

export interface VfsPage<T> {
  items: T[]
  nextCursor?: string
  total?: number
}

export interface VfsListOptions {
  recursive?: boolean
  cursor?: string
  limit?: number
}

export interface VfsWriteOptions {
  contentType?: string
  atomic?: boolean
}

export interface VfsDeleteOptions {
  recursive?: boolean
}

export interface VfsCopyMoveOptions {
  overwrite?: boolean
}

export interface VfsImportOptions {
  type?: string
  origin?: ResourceRecord['origin']
  contentType?: string
  projectId?: string
  tags?: string[]
}

export interface VfsImportTextItem {
  ref: VfsRef
  content: string
  options?: VfsImportOptions
}

export interface VfsPackageManifest {
  schemaVersion: 1
  packageId: string
  createdAtMs: number
  files: VfsPackageFileManifest[]
  roots: Partial<Record<VfsRootId, string>>
  metadata?: Record<string, string | number | boolean>
}

export interface VfsPackageFileManifest {
  root: VfsRootId
  path: string
  relativePath: string
  fingerprint: string
  size: number
  contentType?: string
  resourceId?: string
  parserVersions?: Record<string, string>
}

export interface VfsPackageFile extends VfsPackageFileManifest {
  content: Uint8Array
}

export interface VfsPackage {
  manifest: VfsPackageManifest
  files: VfsPackageFile[]
}

export interface VfsExportPackageOptions {
  packageId?: string
  nowMs?: number
  metadata?: Record<string, string | number | boolean>
}

export interface VfsImportPackageOptions {
  targetRoot?: VfsRootId
  pathPrefix?: string
  rootMap?: Partial<Record<VfsRootId, VfsRootId>>
  origin?: ResourceRecord['origin']
}

export type ProjectResourceFolderKind =
  | 'source'
  | 'imports'
  | 'generated'
  | 'packages'
  | 'metadata'
  | 'manifests'

export interface ProjectResourceFolderManifest {
  kind: ProjectResourceFolderKind
  label: string
  ref: VfsRef
  catalogPathPrefix: string
  mutable: boolean
  portable: boolean
  packageRole: 'source' | 'import-staging' | 'generated-output' | 'package-staging' | 'metadata'
}

export interface ProjectResourceManifest {
  schemaVersion: 1
  projectId: string
  createdAtMs: number
  updatedAtMs: number
  projectRef: VfsRef
  projectFileRef: VfsRef
  resourcesRef: VfsRef
  folders: Record<ProjectResourceFolderKind, ProjectResourceFolderManifest>
  catalog: {
    root: 'projects'
    projectPathPrefix: string
    resourcePathPrefix: string
    stableIds: true
    moveStrategy: 'catalog-prefix-update'
  }
  package: {
    preserveRelativePaths: true
    defaultExportRef: VfsRef
    importStagingRef: VfsRef
  }
  web: {
    safeUrlRequired: true
    allowedRoutes: VfsWebRoute[]
  }
  mcp: {
    scope: string
    allowedRoots: VfsRootId[]
    pathPrefix: string
  }
  metadata?: Record<string, string | number | boolean>
}

export interface CreateProjectResourceManifestOptions {
  nowMs?: number
  metadata?: Record<string, string | number | boolean>
  folderLabels?: Partial<Record<ProjectResourceFolderKind, string>>
}

export interface VfsBridge {
  exists(ref: VfsRef): Promise<ApiResult<boolean>>
  stat(ref: VfsRef): Promise<ApiResult<VfsEntry>>
  ensureDirectory(ref: VfsRef): Promise<ApiResult<VfsEntry>>
  readText(ref: VfsRef): Promise<ApiResult<string>>
  readBytes(ref: VfsRef): Promise<ApiResult<Uint8Array>>
  writeText(ref: VfsRef, content: string, options?: VfsWriteOptions): Promise<ApiResult<VfsEntry>>
  writeBytes(
    ref: VfsRef,
    content: Uint8Array,
    options?: VfsWriteOptions
  ): Promise<ApiResult<VfsEntry>>
  writeTextAtomic(
    ref: VfsRef,
    content: string,
    options?: VfsWriteOptions
  ): Promise<ApiResult<VfsEntry>>
  delete(ref: VfsRef, options?: VfsDeleteOptions): Promise<ApiResult<void>>
  copy(source: VfsRef, target: VfsRef, options?: VfsCopyMoveOptions): Promise<ApiResult<VfsEntry>>
  move(source: VfsRef, target: VfsRef, options?: VfsCopyMoveOptions): Promise<ApiResult<VfsEntry>>
  list(root: VfsRootId, dir?: string, options?: VfsListOptions): Promise<ApiResult<VfsEntry[]>>
  listPage(
    root: VfsRootId,
    dir?: string,
    options?: VfsListOptions
  ): Promise<ApiResult<VfsPage<VfsEntry>>>
  importText(
    ref: VfsRef,
    content: string,
    options?: VfsImportOptions
  ): Promise<ApiResult<ResourceRecord>>
  importManyText(items: VfsImportTextItem[]): Promise<ApiResult<ResourceRecord[]>>
  exportText(ref: VfsRef): Promise<ApiResult<{ name: string; content: string }>>
  exportPackage(refs: VfsRef[], options?: VfsExportPackageOptions): Promise<ApiResult<VfsPackage>>
  importPackage(
    pkg: VfsPackage,
    options?: VfsImportPackageOptions
  ): Promise<ApiResult<ResourceRecord[]>>
  cleanup(policy?: VfsCleanupPolicy): Promise<ApiResult<VfsCleanupResult>>
}

export interface ResourceRecord {
  id: string
  type: string
  origin: 'packaged' | 'project' | 'imported' | 'generated' | 'exported'
  fingerprint: string
  size: number
  createdAtMs: number
  updatedAtMs: number
  root: VfsRootId
  path: string
  uri: string
  mutable: boolean
  contentType?: string
  projectId?: string
  tags?: string[]
  rating?: number
  colorLabel?: string
  notes?: string
  annotations?: ResourceAnnotation[]
  favorite?: boolean
  virtualFolders?: string[]
  collections?: string[]
  importBatchId?: string
  source?: ResourceImportProvenance
  derivatives?: ResourceDerivativeRecord[]
  pluginMetadata?: Record<string, VersionedResourceMetadata>
  deletedAtMs?: number
  trashedAtMs?: number
}

export interface ResourceImportBatch {
  id: string
  sourceKind: ResourceImportProvenance['sourceKind']
  createdAtMs: number
  title?: string
  sourceUrl?: string
  originalPath?: string
  referrer?: string
  licenseNote?: string
  tags?: string[]
  resourceIds: string[]
}

export interface ResourceCatalogFilter {
  root?: VfsRootId
  type?: string
  origin?: ResourceRecord['origin']
  mutable?: boolean
  projectId?: string
  tag?: string
  ratingMin?: number
  ratingMax?: number
  colorLabel?: string
  favorite?: boolean
  fingerprint?: string
  extension?: string
  contentType?: string
  pathPrefix?: string
  virtualFolder?: string
  collection?: string
  duplicateOf?: string
  importBatchId?: string
  sourceKind?: ResourceImportProvenance['sourceKind']
  pluginId?: string
  pluginStatus?: VersionedResourceMetadata['status']
  includeTrashed?: boolean
  cursor?: string
  limit?: number
}

export interface ResourceCatalog {
  upsert(record: ResourceRecord): ResourceRecord
  upsertMany(records: ResourceRecord[]): ResourceRecord[]
  get(id: string): ResourceRecord | undefined
  find(filter?: ResourceCatalogFilter): ResourceRecord[]
  findPage(filter?: ResourceCatalogFilter): VfsPage<ResourceRecord>
  querySmartFolder(folder: ResourceSmartFolder): VfsPage<ResourceRecord>
  count(filter?: Omit<ResourceCatalogFilter, 'cursor' | 'limit'>): number
  findDuplicates(fingerprint: string): ResourceRecord[]
  movePathPrefix(root: VfsRootId, sourcePrefix: string, targetPrefix: string): number
  upsertDerivative(
    resourceId: string,
    derivative: ResourceDerivativeRecord
  ): ResourceRecord | undefined
  listDerivatives(resourceId: string): ResourceDerivativeRecord[]
  invalidateDerivatives(resourceId: string, nowMs?: number): ResourceDerivativeRecord[]
  cleanupInvalidDerivatives(nowMs?: number): ResourceDerivativeRecord[]
  recordImportBatch(batch: ResourceImportBatch): ResourceImportBatch
  getImportBatch(id: string): ResourceImportBatch | undefined
  listImportBatches(): ResourceImportBatch[]
  reconcileExternalChange(
    id: string,
    content: string | Uint8Array,
    nowMs?: number
  ): ResourceRecord | undefined
  removeFromCollection(id: string, collection: string): ResourceRecord | undefined
  markTrashed(id: string, nowMs?: number): ResourceRecord | undefined
  restore(id: string): ResourceRecord | undefined
  purgeTrashed(nowMs?: number): ResourceRecord[]
  list(): ResourceRecord[]
  remove(id: string): void
}

export interface ResourceAnnotation {
  id: string
  kind: 'note' | 'region' | 'timecode' | 'frame'
  text: string
  createdAtMs: number
  data?: Record<string, string | number | boolean>
}

export interface ResourceDerivativeRecord {
  id: string
  resourceId: string
  kind: 'thumbnail' | 'preview' | 'proxy' | 'histogram' | 'sidecar'
  root: VfsRootId
  path: string
  sourceFingerprint: string
  pluginId?: string
  pluginVersion?: string
  width?: number
  height?: number
  size?: number
  invalidatedAtMs?: number
}

export interface ResourceImportProvenance {
  sourceKind:
    | 'local-file'
    | 'browser-capture'
    | 'drag-drop'
    | 'clipboard'
    | 'watched-folder'
    | 'package'
  importBatchId?: string
  originalPath?: string
  sourceUrl?: string
  title?: string
  referrer?: string
  licenseNote?: string
  capturedAtMs?: number
}

export interface VersionedResourceMetadata {
  pluginId: string
  pluginVersion: string
  schemaVersion: string
  status: 'ready' | 'failed' | 'stale'
  updatedAtMs: number
  data: Record<string, unknown>
  errorCode?: string
}

export interface ResourceSmartFolder {
  id: string
  name: string
  filter: ResourceCatalogFilter
  sort?: Array<{
    field: 'path' | 'updatedAtMs' | 'createdAtMs' | 'size' | 'rating'
    direction: 'asc' | 'desc'
  }>
}

export interface VfsCleanupPolicy {
  roots?: VfsRootId[]
  nowMs?: number
  maxAgeMs?: number
  dryRun?: boolean
}

export interface VfsCleanupResult {
  removed: VfsEntry[]
  preserved: VfsEntry[]
}

interface StoredEntry {
  entry: VfsEntry
  content?: string | Uint8Array
}

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/
const MUTATING_OPERATIONS = new Set<VfsOperation>(['write', 'delete', 'mkdir', 'move', 'import'])
const ALL_OPERATIONS: VfsOperation[] = [
  'read',
  'write',
  'delete',
  'list',
  'stat',
  'mkdir',
  'copy',
  'move',
  'import',
  'export',
  'package',
  'cleanup'
]
const READONLY_OPERATIONS: VfsOperation[] = ['read', 'list', 'stat', 'copy', 'export', 'package']

export function createDefaultVfsRoots(basePath: string): VfsRootMap {
  const root = basePath.replace(/[\\/]+$/, '')
  return {
    'app-data': {
      id: 'app-data',
      path: `${root}/app-data`,
      mutable: true,
      cleanup: 'never'
    },
    projects: {
      id: 'projects',
      path: `${root}/projects`,
      mutable: true,
      cleanup: 'never'
    },
    imports: {
      id: 'imports',
      path: `${root}/imports`,
      mutable: true,
      cleanup: 'never'
    },
    assets: {
      id: 'assets',
      path: `${root}/assets`,
      mutable: false,
      cleanup: 'never'
    },
    cache: {
      id: 'cache',
      path: `${root}/cache`,
      mutable: true,
      cleanup: 'cache'
    },
    logs: { id: 'logs', path: `${root}/logs`, mutable: true, cleanup: 'logs' },
    tmp: { id: 'tmp', path: `${root}/tmp`, mutable: true, cleanup: 'tmp' },
    exports: {
      id: 'exports',
      path: `${root}/exports`,
      mutable: true,
      cleanup: 'never'
    }
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)
}

function validateSegment(segment: string): string | undefined {
  if (!segment || segment === '.' || segment === '..') return 'VFS path cannot escape its root.'
  if (segment.length > 255) return 'VFS path segment is too long.'
  if (segment.trim() !== segment || /[. ]$/.test(segment)) {
    return 'VFS path segment has unsupported whitespace or trailing punctuation.'
  }
  if (ILLEGAL_SEGMENT_CHARS.test(segment) || RESERVED_WINDOWS_NAMES.test(segment)) {
    return 'VFS path segment is not portable across macOS and Windows.'
  }
  return undefined
}

export function normalizeVfsPath(
  value: string,
  options: { allowEmpty?: boolean } = {}
): ApiResult<string[]> {
  if (value === '' && options.allowEmpty) return bridgeOk([])
  if (!value || isAbsolutePath(value)) {
    return bridgeFail('vfs.invalid_path', 'VFS path must be relative.')
  }

  const segments = value.replace(/\\/g, '/').split('/').filter(Boolean)
  for (const segment of segments) {
    const error = validateSegment(segment)
    if (error) return bridgeFail('vfs.invalid_path', error, { segment })
  }

  return bridgeOk(segments)
}

export function createVfsRef(root: VfsRootId, path: string): ApiResult<VfsRef> {
  const normalized = normalizeVfsPath(path)
  if (!normalized.ok) return normalized
  return bridgeOk({ root, path: normalized.data.join('/') })
}

export function toVfsUri(ref: VfsRef): ApiResult<string> {
  const normalized = normalizeVfsPath(ref.path)
  if (!normalized.ok) return normalized
  return bridgeOk(`vfs://${ref.root}/${normalized.data.map(encodeURIComponent).join('/')}`)
}

export function parseVfsUri(uri: string): ApiResult<VfsRef> {
  if (!uri.startsWith('vfs://')) return bridgeFail('vfs.invalid_uri', 'VFS URI must use vfs://.')
  const withoutScheme = uri.slice('vfs://'.length)
  const slashIndex = withoutScheme.indexOf('/')
  if (slashIndex <= 0) return bridgeFail('vfs.invalid_uri', 'VFS URI is missing a root or path.')
  const root = withoutScheme.slice(0, slashIndex) as VfsRootId
  const path = withoutScheme
    .slice(slashIndex + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
    .join('/')
  return createVfsRef(root, path)
}

export type VfsWebRoute = 'resource' | 'thumbnail' | 'preview' | 'download' | 'stream'

export interface VfsWebUrlOptions {
  origin?: string
  route?: VfsWebRoute
  token?: string
  expiresAtMs?: number
}

export interface ParsedVfsWebUrl {
  ref: VfsRef
  route: VfsWebRoute
  token?: string
  expiresAtMs?: number
}

export function toVfsWebUrl(ref: VfsRef, options: VfsWebUrlOptions = {}): ApiResult<string> {
  const normalized = normalizeVfsPath(ref.path)
  if (!normalized.ok) return normalized

  const origin = (options.origin || 'app://vfs').replace(/\/+$/, '')
  const route = options.route || 'resource'
  const encodedPath = normalized.data.map(encodeURIComponent).join('/')
  const query = new URLSearchParams()
  if (options.token) query.set('token', options.token)
  if (options.expiresAtMs !== undefined) query.set('expiresAtMs', String(options.expiresAtMs))

  const suffix = `${route}/${encodeURIComponent(ref.root)}/${encodedPath}`
  const path = origin === 'app://vfs' ? `/${suffix}` : `/vfs/${suffix}`
  return bridgeOk(`${origin}${path}${query.size ? `?${query.toString()}` : ''}`)
}

export function parseVfsWebUrl(value: string): ApiResult<ParsedVfsWebUrl> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return bridgeFail('vfs.invalid_url', 'VFS web URL is not valid.')
  }

  const pathSegments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const segments =
    url.protocol === 'app:' && url.hostname === 'vfs' && pathSegments.length >= 2
      ? pathSegments
      : pathSegments[0] === 'vfs'
        ? pathSegments.slice(1)
        : []

  const [routeValue, root, ...path] = segments
  if (!routeValue || !root || !path.length) {
    return bridgeFail('vfs.invalid_url', 'VFS web URL is missing route, root, or path.')
  }
  if (!['resource', 'thumbnail', 'preview', 'download', 'stream'].includes(routeValue)) {
    return bridgeFail('vfs.invalid_url', 'VFS web URL route is not supported.', {
      route: routeValue
    })
  }

  const ref = createVfsRef(root as VfsRootId, path.join('/'))
  if (!ref.ok) return ref
  const expiresAtMsValue = url.searchParams.get('expiresAtMs')
  const expiresAtMs = expiresAtMsValue === null ? undefined : Number(expiresAtMsValue)
  if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs)) {
    return bridgeFail('vfs.invalid_url', 'VFS web URL expiration is invalid.')
  }

  return bridgeOk({
    ref: ref.data,
    route: routeValue as VfsWebRoute,
    token: url.searchParams.get('token') || undefined,
    expiresAtMs
  })
}

export function resolveVfsPath(
  roots: VfsRootMap,
  rootId: VfsRootId,
  relativePath: string
): ApiResult<ResolvedVfsPath> {
  const root = roots[rootId]
  if (!root) return bridgeFail('vfs.unknown_root', `Unknown VFS root: ${rootId}`)

  const normalized = normalizeVfsPath(relativePath)
  if (!normalized.ok) return normalized
  const extension = getExtension(normalized.data.join('/'))

  if (root.allowedExtensions?.length && extension && !root.allowedExtensions.includes(extension)) {
    return bridgeFail('vfs.extension_denied', 'VFS path extension is not allowed.', {
      root: rootId,
      extension
    })
  }

  return bridgeOk({
    root: rootId,
    path: normalized.data.join('/'),
    fullPath: `${root.path.replace(/[\\/]+$/, '')}/${normalized.data.join('/')}`,
    segments: normalized.data,
    mutable: root.mutable
  })
}

function operationsForRoot(root: VfsRoot, policy?: VfsPolicy): VfsOperation[] {
  return policy?.permissions?.[root.id] || (root.mutable ? ALL_OPERATIONS : READONLY_OPERATIONS)
}

export function assertVfsPermission(
  roots: VfsRootMap,
  rootId: VfsRootId,
  operation: VfsOperation,
  policy?: VfsPolicy
): ApiResult<VfsRoot> {
  const root = roots[rootId]
  if (!root) return bridgeFail('vfs.unknown_root', `Unknown VFS root: ${rootId}`)
  if (MUTATING_OPERATIONS.has(operation) && !root.mutable) {
    return bridgeFail('vfs.immutable_root', 'VFS root is immutable.', {
      root: rootId,
      operation
    })
  }
  if (!operationsForRoot(root, policy).includes(operation)) {
    return bridgeFail('vfs.permission_denied', `VFS operation is not allowed: ${operation}`, {
      root: rootId,
      operation
    })
  }
  return bridgeOk(root)
}

export function assertVfsWritable(roots: VfsRootMap, ref: VfsRef): ApiResult<ResolvedVfsPath> {
  const permission = assertVfsPermission(roots, ref.root, 'write')
  if (!permission.ok) return permission
  return resolveVfsPath(roots, ref.root, ref.path)
}

export function fingerprintContent(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? TEXT_ENCODER.encode(content) : content
  let hash = 2166136261
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function getExtension(path: string): string {
  const name = path.split('/').pop() || ''
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? TEXT_ENCODER.encode(content).byteLength : content.byteLength
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const value = Number(cursor)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number | undefined
): VfsPage<T> {
  const start = parseCursor(cursor)
  const pageLimit = Math.max(1, Math.min(limit ?? 100, 1000))
  const pageItems = items.slice(start, start + pageLimit)
  const next =
    start + pageItems.length < items.length ? String(start + pageItems.length) : undefined
  return { items: pageItems, nextCursor: next, total: items.length }
}

function joinVfsPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/g, '/').split('/').filter(Boolean).join('/')
}

function replacePrefix(path: string, sourcePrefix: string, targetPrefix: string): string {
  const rest = path === sourcePrefix ? '' : path.slice(sourcePrefix.length).replace(/^\/+/, '')
  return joinVfsPath(targetPrefix, rest)
}

const PROJECT_RESOURCE_FOLDER_PATHS: Record<ProjectResourceFolderKind, string> = {
  source: 'resources/source',
  imports: 'resources/imports',
  generated: 'resources/generated',
  packages: 'resources/packages',
  metadata: 'metadata',
  manifests: 'metadata/manifests'
}

const PROJECT_RESOURCE_FOLDER_LABELS: Record<ProjectResourceFolderKind, string> = {
  source: 'Source',
  imports: 'Imports',
  generated: 'Generated',
  packages: 'Packages',
  metadata: 'Metadata',
  manifests: 'Manifests'
}

const PROJECT_RESOURCE_PACKAGE_ROLES: Record<
  ProjectResourceFolderKind,
  ProjectResourceFolderManifest['packageRole']
> = {
  source: 'source',
  imports: 'import-staging',
  generated: 'generated-output',
  packages: 'package-staging',
  metadata: 'metadata',
  manifests: 'metadata'
}

function normalizeProjectId(projectId: string): ApiResult<string> {
  const normalized = normalizeVfsPath(projectId)
  if (!normalized.ok) return normalized
  if (normalized.data.length !== 1) {
    return bridgeFail('vfs.invalid_project_id', 'Project id must be one portable path segment.')
  }
  return bridgeOk(normalized.data[0])
}

export function createProjectResourceRef(
  projectId: string,
  folder: ProjectResourceFolderKind,
  relativePath = ''
): ApiResult<VfsRef> {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId.ok) return normalizedProjectId
  const normalizedRelative = normalizeVfsPath(relativePath, {
    allowEmpty: true
  })
  if (!normalizedRelative.ok) return normalizedRelative
  return bridgeOk({
    root: 'projects',
    path: joinVfsPath(
      normalizedProjectId.data,
      PROJECT_RESOURCE_FOLDER_PATHS[folder],
      ...normalizedRelative.data
    )
  })
}

export function createProjectResourceManifest(
  projectId: string,
  options: CreateProjectResourceManifestOptions = {}
): ApiResult<ProjectResourceManifest> {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId.ok) return normalizedProjectId
  const id = normalizedProjectId.data
  const now = options.nowMs ?? Date.now()
  const projectRef: VfsRef = { root: 'projects', path: id }
  const projectFileRef: VfsRef = {
    root: 'projects',
    path: joinVfsPath(id, 'project.json')
  }
  const resourcesRef: VfsRef = {
    root: 'projects',
    path: joinVfsPath(id, 'resources')
  }

  const folderEntries = Object.entries(PROJECT_RESOURCE_FOLDER_PATHS).map(([kind, folderPath]) => {
    const folderKind = kind as ProjectResourceFolderKind
    const ref: VfsRef = {
      root: 'projects',
      path: joinVfsPath(id, folderPath)
    }
    const folder: ProjectResourceFolderManifest = {
      kind: folderKind,
      label: options.folderLabels?.[folderKind] || PROJECT_RESOURCE_FOLDER_LABELS[folderKind],
      ref,
      catalogPathPrefix: ref.path,
      mutable: true,
      portable: true,
      packageRole: PROJECT_RESOURCE_PACKAGE_ROLES[folderKind]
    }
    return [folderKind, folder]
  })

  const folders = Object.fromEntries(folderEntries) as Record<
    ProjectResourceFolderKind,
    ProjectResourceFolderManifest
  >

  return bridgeOk({
    schemaVersion: 1,
    projectId: id,
    createdAtMs: now,
    updatedAtMs: now,
    projectRef,
    projectFileRef,
    resourcesRef,
    folders,
    catalog: {
      root: 'projects',
      projectPathPrefix: projectRef.path,
      resourcePathPrefix: resourcesRef.path,
      stableIds: true,
      moveStrategy: 'catalog-prefix-update'
    },
    package: {
      preserveRelativePaths: true,
      defaultExportRef: folders.packages.ref,
      importStagingRef: folders.imports.ref
    },
    web: {
      safeUrlRequired: true,
      allowedRoutes: ['resource', 'thumbnail', 'preview', 'download', 'stream']
    },
    mcp: {
      scope: `project:${id}`,
      allowedRoots: ['projects'],
      pathPrefix: projectRef.path
    },
    metadata: options.metadata
  })
}

export function validateProjectResourceManifest(
  manifest: ProjectResourceManifest
): ApiResult<ProjectResourceManifest> {
  if (manifest.schemaVersion !== 1) {
    return bridgeFail(
      'vfs.project_manifest_unsupported',
      'Project resource manifest schema is not supported.',
      {
        schemaVersion: manifest.schemaVersion
      }
    )
  }

  const expected = createProjectResourceManifest(manifest.projectId, {
    nowMs: manifest.createdAtMs,
    metadata: manifest.metadata
  })
  if (!expected.ok) return expected

  const requiredFolders = Object.keys(PROJECT_RESOURCE_FOLDER_PATHS) as ProjectResourceFolderKind[]
  const missingFolder = requiredFolders.find((folder) => !manifest.folders[folder])
  if (missingFolder) {
    return bridgeFail(
      'vfs.project_manifest_invalid',
      'Project resource manifest is missing a required folder.',
      {
        folder: missingFolder
      }
    )
  }

  for (const folder of requiredFolders) {
    const actual = manifest.folders[folder]
    const wanted = expected.data.folders[folder]
    if (
      actual.ref.root !== 'projects' ||
      actual.ref.path !== wanted.ref.path ||
      actual.catalogPathPrefix !== wanted.catalogPathPrefix
    ) {
      return bridgeFail(
        'vfs.project_manifest_invalid',
        'Project resource folder does not match the VFS project layout.',
        {
          folder,
          expected: wanted.ref.path,
          actual: actual.ref.path
        }
      )
    }
  }

  if (
    manifest.projectRef.root !== 'projects' ||
    manifest.projectRef.path !== expected.data.projectRef.path ||
    manifest.projectFileRef.path !== expected.data.projectFileRef.path ||
    manifest.resourcesRef.path !== expected.data.resourcesRef.path ||
    manifest.catalog.moveStrategy !== 'catalog-prefix-update' ||
    manifest.package.preserveRelativePaths !== true ||
    manifest.web.safeUrlRequired !== true ||
    !manifest.mcp.allowedRoots.includes('projects')
  ) {
    return bridgeFail(
      'vfs.project_manifest_invalid',
      'Project resource manifest does not match required project VFS contracts.'
    )
  }

  return bridgeOk(manifest)
}

export function createResourceRecord(input: {
  id: string
  type: string
  origin: ResourceRecord['origin']
  content: string | Uint8Array
  root: VfsRootId
  path: string
  mutable: boolean
  uri?: string
  contentType?: string
  projectId?: string
  tags?: string[]
  rating?: number
  colorLabel?: string
  notes?: string
  annotations?: ResourceAnnotation[]
  favorite?: boolean
  virtualFolders?: string[]
  collections?: string[]
  importBatchId?: string
  source?: ResourceImportProvenance
  derivatives?: ResourceDerivativeRecord[]
  pluginMetadata?: Record<string, VersionedResourceMetadata>
  nowMs?: number
}): ResourceRecord {
  const now = input.nowMs ?? Date.now()
  return {
    id: input.id,
    type: input.type,
    origin: input.origin,
    fingerprint: fingerprintContent(input.content),
    size: byteLength(input.content),
    createdAtMs: now,
    updatedAtMs: now,
    root: input.root,
    path: input.path,
    uri: input.uri || `vfs://${input.root}/${input.path}`,
    mutable: input.mutable,
    contentType: input.contentType,
    projectId: input.projectId,
    tags: input.tags,
    rating: input.rating,
    colorLabel: input.colorLabel,
    notes: input.notes,
    annotations: input.annotations,
    favorite: input.favorite,
    virtualFolders: input.virtualFolders,
    collections: input.collections,
    importBatchId: input.importBatchId,
    source: input.source,
    derivatives: input.derivatives,
    pluginMetadata: input.pluginMetadata
  }
}

export function createResourceCatalog(initialRecords: ResourceRecord[] = []): ResourceCatalog {
  const records = new Map(initialRecords.map((record) => [record.id, record]))
  const importBatches = new Map<string, ResourceImportBatch>()

  function matches(record: ResourceRecord, filter: ResourceCatalogFilter = {}): boolean {
    const duplicateOfRecord = filter.duplicateOf ? records.get(filter.duplicateOf) : undefined
    return (
      (filter.root === undefined || record.root === filter.root) &&
      (filter.type === undefined || record.type === filter.type) &&
      (filter.origin === undefined || record.origin === filter.origin) &&
      (filter.mutable === undefined || record.mutable === filter.mutable) &&
      (filter.projectId === undefined || record.projectId === filter.projectId) &&
      (filter.tag === undefined || record.tags?.includes(filter.tag) === true) &&
      (filter.ratingMin === undefined || (record.rating ?? 0) >= filter.ratingMin) &&
      (filter.ratingMax === undefined || (record.rating ?? 0) <= filter.ratingMax) &&
      (filter.colorLabel === undefined || record.colorLabel === filter.colorLabel) &&
      (filter.favorite === undefined || record.favorite === filter.favorite) &&
      (filter.fingerprint === undefined || record.fingerprint === filter.fingerprint) &&
      (filter.extension === undefined || getExtension(record.path) === filter.extension) &&
      (filter.contentType === undefined || record.contentType === filter.contentType) &&
      (filter.pathPrefix === undefined ||
        record.path === filter.pathPrefix ||
        record.path.startsWith(`${filter.pathPrefix}/`)) &&
      (filter.virtualFolder === undefined ||
        record.virtualFolders?.includes(filter.virtualFolder) === true) &&
      (filter.collection === undefined ||
        record.collections?.includes(filter.collection) === true) &&
      (filter.importBatchId === undefined || record.importBatchId === filter.importBatchId) &&
      (filter.sourceKind === undefined || record.source?.sourceKind === filter.sourceKind) &&
      (filter.pluginId === undefined || record.pluginMetadata?.[filter.pluginId] !== undefined) &&
      (filter.pluginStatus === undefined ||
        Object.values(record.pluginMetadata || {}).some(
          (metadata) => metadata.status === filter.pluginStatus
        )) &&
      (filter.includeTrashed === true || record.trashedAtMs === undefined) &&
      (duplicateOfRecord === undefined ||
        (record.id !== duplicateOfRecord.id &&
          record.fingerprint === duplicateOfRecord.fingerprint))
    )
  }

  function sortRecords(
    nextRecords: ResourceRecord[],
    sort: ResourceSmartFolder['sort'] = []
  ): ResourceRecord[] {
    return [...nextRecords].sort((left, right) => {
      for (const item of sort) {
        const direction = item.direction === 'desc' ? -1 : 1
        const leftValue = left[item.field] ?? 0
        const rightValue = right[item.field] ?? 0
        if (leftValue < rightValue) return -1 * direction
        if (leftValue > rightValue) return 1 * direction
      }
      return left.path.localeCompare(right.path)
    })
  }

  function stalePluginMetadata(
    metadata: Record<string, VersionedResourceMetadata> | undefined,
    nowMs: number
  ): Record<string, VersionedResourceMetadata> | undefined {
    if (!metadata) return undefined
    return Object.fromEntries(
      Object.entries(metadata).map(([id, value]) => [
        id,
        { ...value, status: 'stale' as const, updatedAtMs: nowMs }
      ])
    )
  }

  const catalog: ResourceCatalog = {
    upsert(record) {
      records.set(record.id, record)
      return { ...record }
    },
    upsertMany(nextRecords) {
      for (const record of nextRecords) records.set(record.id, record)
      return nextRecords.map((record) => ({ ...record }))
    },
    get(id) {
      const record = records.get(id)
      return record ? { ...record } : undefined
    },
    find(filter = {}) {
      return [...records.values()]
        .filter((record) => matches(record, filter))
        .map((record) => ({ ...record }))
    },
    findPage(filter = {}) {
      return paginate(this.find(filter), filter.cursor, filter.limit)
    },
    querySmartFolder(folder) {
      const matched = sortRecords(this.find(folder.filter), folder.sort)
      return paginate(matched, folder.filter.cursor, folder.filter.limit)
    },
    count(filter = {}) {
      return [...records.values()].filter((record) => matches(record, filter)).length
    },
    findDuplicates(fingerprint) {
      return this.find({ fingerprint })
    },
    movePathPrefix(root, sourcePrefix, targetPrefix) {
      const source = joinVfsPath(sourcePrefix)
      const target = joinVfsPath(targetPrefix)
      let moved = 0
      for (const [id, record] of records.entries()) {
        if (
          record.root !== root ||
          !(record.path === source || record.path.startsWith(`${source}/`))
        ) {
          continue
        }
        const path = replacePrefix(record.path, source, target)
        records.set(id, {
          ...record,
          path,
          uri: `vfs://${record.root}/${path}`
        })
        moved += 1
      }
      return moved
    },
    upsertDerivative(resourceId, derivative) {
      const record = records.get(resourceId)
      if (!record) return undefined
      const derivatives = [
        ...(record.derivatives || []).filter((item) => item.id !== derivative.id),
        derivative
      ]
      const next = { ...record, derivatives }
      records.set(resourceId, next)
      return { ...next }
    },
    listDerivatives(resourceId) {
      return [...(records.get(resourceId)?.derivatives || [])]
    },
    invalidateDerivatives(resourceId, nowMs = Date.now()) {
      const record = records.get(resourceId)
      if (!record) return []
      const derivatives = (record.derivatives || []).map((derivative) => ({
        ...derivative,
        invalidatedAtMs: nowMs
      }))
      records.set(resourceId, { ...record, derivatives })
      return derivatives
    },
    cleanupInvalidDerivatives(nowMs = Date.now()) {
      const removed: ResourceDerivativeRecord[] = []
      for (const [id, record] of records.entries()) {
        const derivatives = record.derivatives || []
        const kept = derivatives.filter((derivative) => {
          const invalid =
            derivative.invalidatedAtMs !== undefined && derivative.invalidatedAtMs <= nowMs
          if (invalid) removed.push(derivative)
          return !invalid
        })
        if (kept.length !== derivatives.length) records.set(id, { ...record, derivatives: kept })
      }
      return removed
    },
    recordImportBatch(batch) {
      importBatches.set(batch.id, {
        ...batch,
        resourceIds: [...batch.resourceIds]
      })
      for (const resourceId of batch.resourceIds) {
        const record = records.get(resourceId)
        if (!record) continue
        records.set(resourceId, {
          ...record,
          importBatchId: batch.id,
          tags: Array.from(new Set([...(record.tags || []), ...(batch.tags || [])])),
          source: {
            sourceKind: batch.sourceKind,
            importBatchId: batch.id,
            originalPath: batch.originalPath,
            sourceUrl: batch.sourceUrl,
            title: batch.title,
            referrer: batch.referrer,
            licenseNote: batch.licenseNote,
            capturedAtMs: batch.createdAtMs
          }
        })
      }
      return { ...batch, resourceIds: [...batch.resourceIds] }
    },
    getImportBatch(id) {
      const batch = importBatches.get(id)
      return batch ? { ...batch, resourceIds: [...batch.resourceIds] } : undefined
    },
    listImportBatches() {
      return [...importBatches.values()].map((batch) => ({
        ...batch,
        resourceIds: [...batch.resourceIds]
      }))
    },
    reconcileExternalChange(id, content, nowMs = Date.now()) {
      const record = records.get(id)
      if (!record) return undefined
      const next = {
        ...record,
        fingerprint: fingerprintContent(content),
        size: byteLength(content),
        updatedAtMs: nowMs,
        derivatives: (record.derivatives || []).map((derivative) => ({
          ...derivative,
          invalidatedAtMs: nowMs
        })),
        pluginMetadata: stalePluginMetadata(record.pluginMetadata, nowMs)
      }
      records.set(id, next)
      return { ...next }
    },
    removeFromCollection(id, collection) {
      const record = records.get(id)
      if (!record) return undefined
      const next = {
        ...record,
        collections: (record.collections || []).filter((item) => item !== collection)
      }
      records.set(id, next)
      return { ...next }
    },
    markTrashed(id, nowMs = Date.now()) {
      const record = records.get(id)
      if (!record) return undefined
      const next = { ...record, trashedAtMs: nowMs }
      records.set(id, next)
      return { ...next }
    },
    restore(id) {
      const record = records.get(id)
      if (!record) return undefined
      const next = {
        ...record,
        trashedAtMs: undefined,
        deletedAtMs: undefined
      }
      records.set(id, next)
      return { ...next }
    },
    purgeTrashed(nowMs = Date.now()) {
      const purged: ResourceRecord[] = []
      for (const [id, record] of records.entries()) {
        if (record.trashedAtMs === undefined || record.trashedAtMs > nowMs) continue
        const next = { ...record, deletedAtMs: nowMs }
        purged.push(next)
        records.delete(id)
      }
      return purged
    },
    list() {
      return this.find()
    },
    remove(id) {
      records.delete(id)
    }
  }
  return catalog
}

export function createVfsRepositoryStorage(
  vfs: VfsBridge,
  root: VfsRootId = 'projects'
): RepositoryStorage {
  return {
    async read(namespace, key, fallback) {
      const result = await vfs.readText({
        root,
        path: `${namespace}/${key}.json`
      })
      return result.ok ? JSON.parse(result.data) : fallback
    },
    async write(namespace, key, value) {
      const result = await vfs.writeTextAtomic(
        { root, path: `${namespace}/${key}.json` },
        JSON.stringify(value)
      )
      if (!result.ok) throw new Error(result.error.message)
    },
    async remove(namespace, key) {
      await vfs.delete({ root, path: `${namespace}/${key}.json` })
    }
  }
}

export function createMemoryVfs(
  roots: VfsRootMap,
  options: {
    clock?: () => number
    catalog?: ResourceCatalog
    policy?: VfsPolicy
  } = {}
): VfsBridge {
  const entries = new Map<string, StoredEntry>()
  const clock = options.clock || Date.now
  const catalog = options.catalog || createResourceCatalog()
  const policy = options.policy

  function keyForResolved(resolved: ResolvedVfsPath): string {
    const root = roots[resolved.root]
    return root.caseSensitive ? resolved.fullPath : resolved.fullPath.toLowerCase()
  }

  function keyForRef(ref: VfsRef): ApiResult<string> {
    const resolved = resolveVfsPath(roots, ref.root, ref.path)
    return resolved.ok ? bridgeOk(keyForResolved(resolved.data)) : resolved
  }

  function deleteByRef(ref: VfsRef): void {
    const key = keyForRef(ref)
    if (key.ok) entries.delete(key.data)
  }

  function entryFor(ref: VfsRef): ApiResult<StoredEntry> {
    const permission = assertVfsPermission(roots, ref.root, 'read', policy)
    if (!permission.ok) return permission
    const key = keyForRef(ref)
    if (!key.ok) return key
    const record = entries.get(key.data)
    return record ? bridgeOk(record) : bridgeFail('vfs.not_found', 'VFS entry not found.', ref)
  }

  function toEntry(
    resolved: ResolvedVfsPath,
    type: VfsEntry['type'],
    content: string | Uint8Array = '',
    options: VfsWriteOptions = {}
  ): VfsEntry {
    const existing = entries.get(keyForResolved(resolved))
    const now = clock()
    return {
      ref: { root: resolved.root, path: resolved.path },
      uri: toVfsUri({ root: resolved.root, path: resolved.path }).ok
        ? `vfs://${resolved.root}/${resolved.segments.map(encodeURIComponent).join('/')}`
        : '',
      fullPath: resolved.fullPath,
      size: type === 'directory' ? 0 : byteLength(content),
      createdAtMs: existing?.entry.createdAtMs || now,
      updatedAtMs: now,
      type,
      contentType: options.contentType
    }
  }

  function checkWriteSize(rootId: VfsRootId, content: string | Uint8Array): ApiResult<void> {
    const maxBytes = policy?.maxFileBytes?.[rootId] ?? roots[rootId].maxFileBytes
    if (maxBytes !== undefined && byteLength(content) > maxBytes) {
      return bridgeFail('vfs.file_too_large', 'VFS file exceeds the configured size limit.', {
        root: rootId,
        maxBytes
      })
    }
    return bridgeOk(undefined)
  }

  function ensureParentDirectories(resolved: ResolvedVfsPath): void {
    for (let index = 1; index < resolved.segments.length; index += 1) {
      const path = resolved.segments.slice(0, index).join('/')
      const dir = resolveVfsPath(roots, resolved.root, path)
      if (!dir.ok) continue
      const key = keyForResolved(dir.data)
      if (!entries.has(key)) {
        const entry = toEntry(dir.data, 'directory')
        entries.set(key, { entry })
      }
    }
  }

  function writeEntry(
    ref: VfsRef,
    content: string | Uint8Array,
    options: VfsWriteOptions = {}
  ): ApiResult<VfsEntry> {
    const permission = assertVfsPermission(roots, ref.root, 'write', policy)
    if (!permission.ok) return permission
    const size = checkWriteSize(ref.root, content)
    if (!size.ok) return size
    const resolved = resolveVfsPath(roots, ref.root, ref.path)
    if (!resolved.ok) return resolved

    ensureParentDirectories(resolved.data)
    const entry = toEntry(resolved.data, 'file', content, options)
    entries.set(keyForResolved(resolved.data), {
      content: typeof content === 'string' ? content : new Uint8Array(content),
      entry
    })
    return bridgeOk({ ...entry })
  }

  function entriesBelow(directory: VfsEntry): StoredEntry[] {
    const prefix = directory.fullPath.endsWith('/') ? directory.fullPath : `${directory.fullPath}/`
    return [...entries.values()].filter((entry) => entry.entry.fullPath.startsWith(prefix))
  }

  function cloneStoredEntry(targetRef: VfsRef, source: StoredEntry): ApiResult<VfsEntry> {
    if (source.entry.type === 'directory') {
      const permission = assertVfsPermission(roots, targetRef.root, 'mkdir', policy)
      if (!permission.ok) return permission
      const resolved = resolveVfsPath(roots, targetRef.root, targetRef.path)
      if (!resolved.ok) return resolved
      ensureParentDirectories(resolved.data)
      const entry = toEntry(resolved.data, 'directory')
      entries.set(keyForResolved(resolved.data), { entry })
      return bridgeOk({ ...entry })
    }

    const content = source.content || ''
    return writeEntry(targetRef, content, {
      contentType: source.entry.contentType
    })
  }

  return {
    async exists(ref) {
      const key = keyForRef(ref)
      return key.ok ? bridgeOk(entries.has(key.data)) : key
    },
    async stat(ref) {
      const record = entryFor(ref)
      return record.ok ? bridgeOk({ ...record.data.entry }) : record
    },
    async ensureDirectory(ref) {
      const permission = assertVfsPermission(roots, ref.root, 'mkdir', policy)
      if (!permission.ok) return permission
      const resolved = resolveVfsPath(roots, ref.root, ref.path)
      if (!resolved.ok) return resolved
      ensureParentDirectories(resolved.data)
      const entry = toEntry(resolved.data, 'directory')
      entries.set(keyForResolved(resolved.data), { entry })
      return bridgeOk({ ...entry })
    },
    async readText(ref) {
      const record = entryFor(ref)
      if (!record.ok) return record
      if (record.data.entry.type !== 'file') {
        return bridgeFail('vfs.not_file', 'VFS entry is not a file.', ref)
      }
      const content = record.data.content
      return typeof content === 'string'
        ? bridgeOk(content)
        : bridgeOk(TEXT_DECODER.decode(content || new Uint8Array()))
    },
    async readBytes(ref) {
      const record = entryFor(ref)
      if (!record.ok) return record
      if (record.data.entry.type !== 'file') {
        return bridgeFail('vfs.not_file', 'VFS entry is not a file.', ref)
      }
      const content = record.data.content
      return typeof content === 'string'
        ? bridgeOk(TEXT_ENCODER.encode(content))
        : bridgeOk(new Uint8Array(content || new Uint8Array()))
    },
    async writeText(ref, content, writeOptions = {}) {
      return writeEntry(ref, content, writeOptions)
    },
    async writeBytes(ref, content, writeOptions = {}) {
      return writeEntry(ref, content, writeOptions)
    },
    async writeTextAtomic(ref, content, writeOptions = {}) {
      return writeEntry(ref, content, { ...writeOptions, atomic: true })
    },
    async delete(ref, deleteOptions = {}) {
      const permission = assertVfsPermission(roots, ref.root, 'delete', policy)
      if (!permission.ok) return permission
      const key = keyForRef(ref)
      if (!key.ok) return key
      const record = entries.get(key.data)
      if (!record) return bridgeOk(undefined)

      if (record.entry.type === 'directory') {
        const prefix = record.entry.fullPath.endsWith('/')
          ? record.entry.fullPath
          : `${record.entry.fullPath}/`
        const children = [...entries.values()].filter((entry) =>
          entry.entry.fullPath.startsWith(prefix)
        )
        if (children.length && !deleteOptions.recursive) {
          return bridgeFail('vfs.directory_not_empty', 'VFS directory is not empty.', ref)
        }
        for (const child of children) deleteByRef(child.entry.ref)
      }

      entries.delete(key.data)
      return bridgeOk(undefined)
    },
    async copy(source, target, copyOptions = {}) {
      const sourcePermission = assertVfsPermission(roots, source.root, 'copy', policy)
      if (!sourcePermission.ok) return sourcePermission
      const targetPermission = assertVfsPermission(roots, target.root, 'write', policy)
      if (!targetPermission.ok) return targetPermission
      const existing = await this.exists(target)
      if (existing.ok && existing.data && !copyOptions.overwrite) {
        return bridgeFail('vfs.already_exists', 'VFS target already exists.', target)
      }
      const sourceEntry = entryFor(source)
      if (!sourceEntry.ok) return sourceEntry

      if (sourceEntry.data.entry.type === 'directory') {
        const targetResolved = resolveVfsPath(roots, target.root, target.path)
        if (!targetResolved.ok) return targetResolved
        const sourcePrefix = sourceEntry.data.entry.fullPath.endsWith('/')
          ? sourceEntry.data.entry.fullPath
          : `${sourceEntry.data.entry.fullPath}/`
        if (
          targetResolved.data.fullPath === sourceEntry.data.entry.fullPath ||
          targetResolved.data.fullPath.startsWith(sourcePrefix)
        ) {
          return bridgeFail('vfs.invalid_target', 'Cannot copy a directory into itself.', {
            source,
            target
          })
        }
        const children = entriesBelow(sourceEntry.data.entry)
        const targetDirectory = cloneStoredEntry(target, sourceEntry.data)
        if (!targetDirectory.ok) return targetDirectory

        for (const child of children) {
          const nextPath = replacePrefix(
            child.entry.ref.path,
            sourceEntry.data.entry.ref.path,
            targetDirectory.data.ref.path
          )
          const copied = cloneStoredEntry({ root: target.root, path: nextPath }, child)
          if (!copied.ok) return copied
        }
        return targetDirectory
      }

      return cloneStoredEntry(target, sourceEntry.data)
    },
    async move(source, target, moveOptions = {}) {
      const permission = assertVfsPermission(roots, source.root, 'move', policy)
      if (!permission.ok) return permission
      const copied = await this.copy(source, target, moveOptions)
      if (!copied.ok) return copied
      const removed = await this.delete(source, { recursive: true })
      if (!removed.ok) return removed
      if (source.root === target.root) {
        catalog.movePathPrefix(source.root, source.path, target.path)
      }
      return copied
    },
    async list(root, dir = '', listOptions = {}) {
      const rootConfig = roots[root]
      if (!rootConfig) return bridgeFail('vfs.unknown_root', `Unknown VFS root: ${root}`)
      const permission = assertVfsPermission(roots, root, 'list', policy)
      if (!permission.ok) return permission
      const resolved = dir ? resolveVfsPath(roots, root, dir) : undefined
      if (resolved && !resolved.ok) return resolved
      const basePath = resolved?.data.fullPath || rootConfig.path
      const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`

      const items = [...entries.values()]
        .filter((record) => record.entry.fullPath.startsWith(prefix))
        .filter((record) => {
          if (listOptions.recursive) return true
          const rest = record.entry.fullPath.slice(prefix.length)
          return rest !== '' && !rest.includes('/')
        })
        .map((record) => ({ ...record.entry }))
      return bridgeOk(items)
    },
    async listPage(root, dir = '', listOptions = {}) {
      const listed = await this.list(root, dir, listOptions)
      if (!listed.ok) return listed
      return bridgeOk(paginate(listed.data, listOptions.cursor, listOptions.limit))
    },
    async importText(ref, content, importOptions = {}) {
      const permission = assertVfsPermission(roots, ref.root, 'import', policy)
      if (!permission.ok) return permission
      const written = await this.writeTextAtomic(ref, content, {
        contentType: importOptions.contentType
      })
      if (!written.ok) return written
      const record = createResourceRecord({
        id: `${ref.root}:${written.data.ref.path}`,
        type: importOptions.type || getExtension(written.data.ref.path) || 'file',
        origin: importOptions.origin || 'imported',
        content,
        root: ref.root,
        path: written.data.ref.path,
        uri: written.data.uri,
        mutable: roots[ref.root].mutable,
        contentType: importOptions.contentType,
        projectId: importOptions.projectId,
        tags: importOptions.tags,
        nowMs: written.data.updatedAtMs
      })
      return bridgeOk(catalog.upsert(record))
    },
    async importManyText(items) {
      const records: ResourceRecord[] = []
      for (const item of items) {
        const imported = await this.importText(item.ref, item.content, item.options)
        if (!imported.ok) return imported
        records.push(imported.data)
      }
      return bridgeOk(records)
    },
    async exportText(ref) {
      const permission = assertVfsPermission(roots, ref.root, 'export', policy)
      if (!permission.ok) return permission
      const content = await this.readText(ref)
      if (!content.ok) return content
      return bridgeOk({
        name: basename(ref.path),
        content: content.data
      })
    },
    async exportPackage(refs, packageOptions = {}) {
      const permissionErrors = refs
        .map((ref) => assertVfsPermission(roots, ref.root, 'package', policy))
        .filter((result) => !result.ok)
      if (permissionErrors.length) return permissionErrors[0] as ApiResult<VfsPackage>

      const files: VfsPackageFile[] = []
      for (const ref of refs) {
        const stat = await this.stat(ref)
        if (!stat.ok) return stat
        if (stat.data.type === 'directory') {
          const listed = await this.list(ref.root, ref.path, {
            recursive: true
          })
          if (!listed.ok) return listed
          for (const entry of listed.data.filter((item) => item.type === 'file')) {
            const content = await this.readBytes(entry.ref)
            if (!content.ok) return content
            files.push({
              root: entry.ref.root,
              path: entry.ref.path,
              relativePath: replacePrefix(entry.ref.path, ref.path, basename(ref.path)),
              fingerprint: fingerprintContent(content.data),
              size: content.data.byteLength,
              contentType: entry.contentType,
              resourceId: `${entry.ref.root}:${entry.ref.path}`,
              content: content.data
            })
          }
          continue
        }

        const content = await this.readBytes(ref)
        if (!content.ok) return content
        files.push({
          root: stat.data.ref.root,
          path: stat.data.ref.path,
          relativePath: basename(stat.data.ref.path),
          fingerprint: fingerprintContent(content.data),
          size: content.data.byteLength,
          contentType: stat.data.contentType,
          resourceId: `${stat.data.ref.root}:${stat.data.ref.path}`,
          content: content.data
        })
      }

      const manifest: VfsPackageManifest = {
        schemaVersion: 1,
        packageId:
          packageOptions.packageId || `pkg:${files.map((file) => file.fingerprint).join(':')}`,
        createdAtMs: packageOptions.nowMs ?? clock(),
        roots: Object.fromEntries(
          [...new Set(files.map((file) => file.root))].map((root) => [root, root])
        ) as Partial<Record<VfsRootId, string>>,
        metadata: packageOptions.metadata,
        files: files.map((file) => ({
          root: file.root,
          path: file.path,
          relativePath: file.relativePath,
          fingerprint: file.fingerprint,
          size: file.size,
          contentType: file.contentType,
          resourceId: file.resourceId,
          parserVersions: file.parserVersions
        }))
      }
      return bridgeOk({ manifest, files })
    },
    async importPackage(pkg, packageOptions = {}) {
      if (pkg.manifest.schemaVersion !== 1) {
        return bridgeFail('vfs.package_unsupported', 'VFS package schema is not supported.', {
          schemaVersion: pkg.manifest.schemaVersion
        })
      }

      const records: ResourceRecord[] = []
      for (const file of pkg.files) {
        const expected = pkg.manifest.files.find(
          (manifestFile) =>
            manifestFile.relativePath === file.relativePath &&
            manifestFile.fingerprint === file.fingerprint
        )
        if (!expected) {
          return bridgeFail('vfs.package_invalid', 'VFS package file is missing from manifest.', {
            relativePath: file.relativePath
          })
        }
        const actualFingerprint = fingerprintContent(file.content)
        if (actualFingerprint !== file.fingerprint) {
          return bridgeFail(
            'vfs.package_fingerprint_mismatch',
            'VFS package file fingerprint does not match.',
            {
              relativePath: file.relativePath
            }
          )
        }

        const targetRoot =
          packageOptions.targetRoot || packageOptions.rootMap?.[file.root] || file.root
        const targetPath = joinVfsPath(packageOptions.pathPrefix || '', file.relativePath)
        const written = await this.writeBytes(
          { root: targetRoot, path: targetPath },
          file.content,
          { contentType: file.contentType }
        )
        if (!written.ok) return written

        const record = createResourceRecord({
          id: `${targetRoot}:${written.data.ref.path}`,
          type: getExtension(written.data.ref.path) || 'file',
          origin: packageOptions.origin || 'imported',
          content: file.content,
          root: targetRoot,
          path: written.data.ref.path,
          uri: written.data.uri,
          mutable: roots[targetRoot].mutable,
          contentType: file.contentType,
          nowMs: written.data.updatedAtMs,
          importBatchId: pkg.manifest.packageId,
          source: {
            sourceKind: 'package',
            importBatchId: pkg.manifest.packageId,
            capturedAtMs: pkg.manifest.createdAtMs
          }
        })
        records.push(catalog.upsert(record))
      }
      return bridgeOk(records)
    },
    async cleanup(cleanupPolicy = {}) {
      const rootsToClean = new Set<VfsRootId>(cleanupPolicy.roots || ['cache', 'tmp'])
      for (const root of rootsToClean) {
        const permission = assertVfsPermission(roots, root, 'cleanup', policy)
        if (!permission.ok) return permission
      }
      const maxAgeMs = cleanupPolicy.maxAgeMs ?? 0
      const now = cleanupPolicy.nowMs ?? clock()
      const removed: VfsEntry[] = []
      const preserved: VfsEntry[] = []

      for (const [key, record] of entries.entries()) {
        const cleanup = roots[record.entry.ref.root].cleanup
        const eligibleRoot = rootsToClean.has(record.entry.ref.root)
        const oldEnough = maxAgeMs <= 0 || now - record.entry.updatedAtMs >= maxAgeMs

        if ((cleanup === 'cache' || cleanup === 'tmp') && eligibleRoot && oldEnough) {
          if (!cleanupPolicy.dryRun) entries.delete(key)
          removed.push({ ...record.entry })
        } else {
          preserved.push({ ...record.entry })
        }
      }

      return bridgeOk({ removed, preserved })
    }
  }
}
