import type { ApiResult } from './contracts'
import { bridgeFail, bridgeOk } from './bridge'
import type {
  CreateProjectResourceManifestOptions,
  ParsedVfsWebUrl,
  ProjectResourceFolderKind,
  ProjectResourceFolderManifest,
  ProjectResourceManifest,
  ResolvedVfsPath,
  VfsRef,
  VfsOperation,
  VfsPolicy,
  VfsPage,
  VfsRoot,
  VfsRootId,
  VfsRootMap,
  VfsWebUrlOptions,
  VfsWebRoute
} from './vfs-types'

export const TEXT_ENCODER = new TextEncoder()
export const TEXT_DECODER = new TextDecoder()
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

export function byteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? TEXT_ENCODER.encode(content).byteLength : content.byteLength
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const value = Number(cursor)
  return Number.isInteger(value) && value >= 0 ? value : 0
}

export function paginate<T>(
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

export function joinVfsPath(...parts: string[]): string {
  return parts.join('/').replace(/\\/g, '/').split('/').filter(Boolean).join('/')
}

export function replacePrefix(path: string, sourcePrefix: string, targetPrefix: string): string {
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
