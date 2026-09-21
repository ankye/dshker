import type { ApiResult } from './contracts'

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
