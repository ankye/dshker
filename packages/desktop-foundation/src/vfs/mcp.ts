import type { ApiResult } from '../contracts'
import { bridgeFail, bridgeOk } from '../bridge'
import type {
  ResourceCatalog,
  ResourceCatalogFilter,
  ResourceImportBatch,
  ResourceSmartFolder,
  VfsBridge,
  VfsCopyMoveOptions,
  VfsDeleteOptions,
  VfsExportPackageOptions,
  VfsImportPackageOptions,
  VfsPackage,
  VfsRef,
  VfsRootMap,
  VfsWebRoute
} from '../vfs'
import { createVfsSignedUrl, type VfsBackgroundJob } from './service'
import type { AssetParserRegistry } from './plugins'
import type { VfsPerformanceProbe } from './performance'

export interface VfsMcpToolDefinition {
  name: VfsMcpToolName
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

export interface VfsMcpToolResponse {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: unknown
  isError?: boolean
}

export type VfsMcpToolName =
  | 'vfs_roots'
  | 'vfs_resolve'
  | 'vfs_stat'
  | 'vfs_list_page'
  | 'vfs_read_text'
  | 'vfs_write_text'
  | 'vfs_delete'
  | 'vfs_copy'
  | 'vfs_move'
  | 'vfs_catalog_get'
  | 'vfs_catalog_query'
  | 'vfs_smart_folder_query'
  | 'vfs_duplicates'
  | 'vfs_derivative_list'
  | 'vfs_derivative_invalidate'
  | 'vfs_derivative_cleanup'
  | 'vfs_import_batch_record'
  | 'vfs_import_batch_list'
  | 'vfs_reconcile_external_change'
  | 'vfs_trash'
  | 'vfs_restore'
  | 'vfs_purge_trash'
  | 'vfs_export_package'
  | 'vfs_import_package'
  | 'vfs_plugin_list'
  | 'vfs_plugin_match'
  | 'vfs_plugin_run'
  | 'vfs_signed_url'
  | 'vfs_jobs'

export interface VfsMcpContext {
  roots: VfsRootMap
  vfs: VfsBridge
  catalog: ResourceCatalog
  plugins?: AssetParserRegistry
  jobs?: () => VfsBackgroundJob[]
  performance?: VfsPerformanceProbe
  signedUrl?: {
    origin: string
    token: string
    expiresAtMs: number
  }
}

export type VfsMcpHandler = (
  toolName: VfsMcpToolName,
  input: Record<string, unknown>
) => Promise<ApiResult<unknown>>

const REF_SCHEMA = {
  type: 'object',
  properties: {
    root: { type: 'string' },
    path: { type: 'string' }
  },
  required: ['root', 'path'],
  additionalProperties: false
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): VfsMcpToolDefinition['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const VFS_MCP_TOOLS: VfsMcpToolDefinition[] = [
  {
    name: 'vfs_roots',
    description: 'List configured VFS roots without exposing local filesystem paths.',
    inputSchema: objectSchema({})
  },
  {
    name: 'vfs_resolve',
    description: 'Validate and normalize a VFS ref.',
    inputSchema: objectSchema({ ref: REF_SCHEMA }, ['ref'])
  },
  {
    name: 'vfs_stat',
    description: 'Get metadata for one VFS entry.',
    inputSchema: objectSchema({ ref: REF_SCHEMA }, ['ref'])
  },
  {
    name: 'vfs_list_page',
    description: 'List a VFS directory with cursor pagination.',
    inputSchema: objectSchema({
      root: { type: 'string' },
      dir: { type: 'string' },
      recursive: { type: 'boolean' },
      cursor: { type: 'string' },
      limit: { type: 'number' }
    })
  },
  {
    name: 'vfs_read_text',
    description: 'Read a small text file through VFS permissions.',
    inputSchema: objectSchema({ ref: REF_SCHEMA }, ['ref'])
  },
  {
    name: 'vfs_write_text',
    description: 'Write a text file through VFS permissions.',
    inputSchema: objectSchema(
      { ref: REF_SCHEMA, content: { type: 'string' }, contentType: { type: 'string' } },
      ['ref', 'content']
    )
  },
  {
    name: 'vfs_delete',
    description: 'Delete a VFS entry with optional recursive directory deletion.',
    inputSchema: objectSchema({ ref: REF_SCHEMA, recursive: { type: 'boolean' } }, ['ref'])
  },
  {
    name: 'vfs_copy',
    description: 'Copy a VFS entry while preserving directory structure.',
    inputSchema: objectSchema(
      { source: REF_SCHEMA, target: REF_SCHEMA, overwrite: { type: 'boolean' } },
      ['source', 'target']
    )
  },
  {
    name: 'vfs_move',
    description: 'Move a VFS entry and update catalog path prefixes when applicable.',
    inputSchema: objectSchema(
      { source: REF_SCHEMA, target: REF_SCHEMA, overwrite: { type: 'boolean' } },
      ['source', 'target']
    )
  },
  {
    name: 'vfs_catalog_get',
    description: 'Get one catalog resource by id.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id'])
  },
  {
    name: 'vfs_catalog_query',
    description: 'Query the resource catalog with indexed filters and cursor pagination.',
    inputSchema: objectSchema({ filter: { type: 'object' } })
  },
  {
    name: 'vfs_smart_folder_query',
    description: 'Run a saved smart-folder catalog query without materializing duplicate files.',
    inputSchema: objectSchema({ folder: { type: 'object' } }, ['folder'])
  },
  {
    name: 'vfs_duplicates',
    description: 'Find resources with the same content fingerprint.',
    inputSchema: objectSchema({ fingerprint: { type: 'string' } }, ['fingerprint'])
  },
  {
    name: 'vfs_derivative_list',
    description: 'List derivative cache records for a resource.',
    inputSchema: objectSchema({ resourceId: { type: 'string' } }, ['resourceId'])
  },
  {
    name: 'vfs_derivative_invalidate',
    description: 'Mark derivative cache records stale for a resource.',
    inputSchema: objectSchema({ resourceId: { type: 'string' }, nowMs: { type: 'number' } }, [
      'resourceId'
    ])
  },
  {
    name: 'vfs_derivative_cleanup',
    description: 'Remove invalid derivative cache records from the catalog.',
    inputSchema: objectSchema({ nowMs: { type: 'number' } })
  },
  {
    name: 'vfs_import_batch_record',
    description: 'Record an import batch and attach safe provenance to resources.',
    inputSchema: objectSchema({ batch: { type: 'object' } }, ['batch'])
  },
  {
    name: 'vfs_import_batch_list',
    description: 'List recorded resource import batches.',
    inputSchema: objectSchema({})
  },
  {
    name: 'vfs_reconcile_external_change',
    description: 'Refresh fingerprint and invalidate derived metadata after an external edit.',
    inputSchema: objectSchema(
      { id: { type: 'string' }, content: { type: 'string' }, nowMs: { type: 'number' } },
      ['id', 'content']
    )
  },
  {
    name: 'vfs_trash',
    description: 'Move a resource record into trash without deleting collection membership.',
    inputSchema: objectSchema({ id: { type: 'string' }, nowMs: { type: 'number' } }, ['id'])
  },
  {
    name: 'vfs_restore',
    description: 'Restore a trashed resource record.',
    inputSchema: objectSchema({ id: { type: 'string' } }, ['id'])
  },
  {
    name: 'vfs_purge_trash',
    description: 'Permanently purge resource records already in trash.',
    inputSchema: objectSchema({ nowMs: { type: 'number' } })
  },
  {
    name: 'vfs_export_package',
    description: 'Export files or folders as a VFS package manifest plus file payloads.',
    inputSchema: objectSchema({ refs: { type: 'array' }, options: { type: 'object' } }, ['refs'])
  },
  {
    name: 'vfs_import_package',
    description: 'Import a VFS package and validate fingerprints before committing records.',
    inputSchema: objectSchema({ package: { type: 'object' }, options: { type: 'object' } }, [
      'package'
    ])
  },
  {
    name: 'vfs_plugin_list',
    description: 'List registered asset parser plugins.',
    inputSchema: objectSchema({})
  },
  {
    name: 'vfs_plugin_match',
    description: 'Find parser plugins for a path, MIME type, or directory signature.',
    inputSchema: objectSchema({ input: { type: 'object' } }, ['input'])
  },
  {
    name: 'vfs_plugin_run',
    description: 'Run a parser plugin against an existing VFS entry.',
    inputSchema: objectSchema({ pluginId: { type: 'string' }, ref: REF_SCHEMA }, [
      'pluginId',
      'ref'
    ])
  },
  {
    name: 'vfs_signed_url',
    description: 'Create a signed web URL for preview, download, thumbnail, or stream access.',
    inputSchema: objectSchema(
      { ref: REF_SCHEMA, route: { type: 'string' }, expiresAtMs: { type: 'number' } },
      ['ref']
    )
  },
  {
    name: 'vfs_jobs',
    description: 'List background VFS service jobs and progress.',
    inputSchema: objectSchema({})
  }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refFrom(value: unknown): ApiResult<VfsRef> {
  if (!isRecord(value) || typeof value.root !== 'string' || typeof value.path !== 'string') {
    return bridgeFail('vfs.mcp_invalid_input', 'MCP tool input must include a VFS ref.')
  }
  return bridgeOk({ root: value.root as VfsRef['root'], path: value.path })
}

function refsFrom(value: unknown): ApiResult<VfsRef[]> {
  if (!Array.isArray(value)) {
    return bridgeFail('vfs.mcp_invalid_input', 'MCP tool input must include refs.')
  }
  const refs: VfsRef[] = []
  for (const item of value) {
    const ref = refFrom(item)
    if (!ref.ok) return ref
    refs.push(ref.data)
  }
  return bridgeOk(refs)
}

function filterFrom(value: unknown): ResourceCatalogFilter {
  return isRecord(value) ? (value as ResourceCatalogFilter) : {}
}

export function createVfsMcpHandler(context: VfsMcpContext): VfsMcpHandler {
  async function handle(
    toolName: VfsMcpToolName,
    input: Record<string, unknown>
  ): Promise<ApiResult<unknown>> {
    switch (toolName) {
      case 'vfs_roots':
        return bridgeOk(
          Object.values(context.roots).map((root) => ({
            id: root.id,
            mutable: root.mutable,
            cleanup: root.cleanup,
            caseSensitive: root.caseSensitive,
            maxFileBytes: root.maxFileBytes,
            allowedExtensions: root.allowedExtensions
          }))
        )
      case 'vfs_resolve': {
        const ref = refFrom(input.ref)
        return ref.ok ? bridgeOk({ root: ref.data.root, path: ref.data.path }) : ref
      }
      case 'vfs_stat': {
        const ref = refFrom(input.ref)
        return ref.ok ? context.vfs.stat(ref.data) : ref
      }
      case 'vfs_list_page':
        return context.vfs.listPage(input.root as VfsRef['root'], input.dir as string | undefined, {
          recursive: input.recursive as boolean | undefined,
          cursor: input.cursor as string | undefined,
          limit: input.limit as number | undefined
        })
      case 'vfs_read_text': {
        const ref = refFrom(input.ref)
        return ref.ok ? context.vfs.readText(ref.data) : ref
      }
      case 'vfs_write_text': {
        const ref = refFrom(input.ref)
        if (!ref.ok) return ref
        if (typeof input.content !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP write text requires string content.')
        }
        return context.vfs.writeText(ref.data, input.content, {
          contentType: input.contentType as string | undefined
        })
      }
      case 'vfs_delete': {
        const ref = refFrom(input.ref)
        const options: VfsDeleteOptions = { recursive: input.recursive as boolean | undefined }
        return ref.ok ? context.vfs.delete(ref.data, options) : ref
      }
      case 'vfs_copy':
      case 'vfs_move': {
        const source = refFrom(input.source)
        if (!source.ok) return source
        const target = refFrom(input.target)
        if (!target.ok) return target
        const options: VfsCopyMoveOptions = { overwrite: input.overwrite as boolean | undefined }
        return toolName === 'vfs_copy'
          ? context.vfs.copy(source.data, target.data, options)
          : context.vfs.move(source.data, target.data, options)
      }
      case 'vfs_catalog_get': {
        if (typeof input.id !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP catalog get requires an id.')
        }
        return bridgeOk(context.catalog.get(input.id))
      }
      case 'vfs_catalog_query':
        return bridgeOk(context.catalog.findPage(filterFrom(input.filter)))
      case 'vfs_smart_folder_query':
        return bridgeOk(context.catalog.querySmartFolder(input.folder as ResourceSmartFolder))
      case 'vfs_duplicates':
        if (typeof input.fingerprint !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP duplicate lookup requires a fingerprint.')
        }
        return bridgeOk(context.catalog.findDuplicates(input.fingerprint))
      case 'vfs_derivative_list':
        if (typeof input.resourceId !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP derivative list requires a resource id.')
        }
        return bridgeOk(context.catalog.listDerivatives(input.resourceId))
      case 'vfs_derivative_invalidate':
        if (typeof input.resourceId !== 'string') {
          return bridgeFail(
            'vfs.mcp_invalid_input',
            'MCP derivative invalidation requires a resource id.'
          )
        }
        return bridgeOk(
          context.catalog.invalidateDerivatives(input.resourceId, input.nowMs as number | undefined)
        )
      case 'vfs_derivative_cleanup':
        return bridgeOk(
          context.catalog.cleanupInvalidDerivatives(input.nowMs as number | undefined)
        )
      case 'vfs_import_batch_record':
        return bridgeOk(context.catalog.recordImportBatch(input.batch as ResourceImportBatch))
      case 'vfs_import_batch_list':
        return bridgeOk(context.catalog.listImportBatches())
      case 'vfs_reconcile_external_change':
        if (typeof input.id !== 'string' || typeof input.content !== 'string') {
          return bridgeFail(
            'vfs.mcp_invalid_input',
            'MCP external reconciliation requires an id and string content.'
          )
        }
        return bridgeOk(
          context.catalog.reconcileExternalChange(
            input.id,
            input.content,
            input.nowMs as number | undefined
          )
        )
      case 'vfs_trash':
        if (typeof input.id !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP trash requires a resource id.')
        }
        return bridgeOk(context.catalog.markTrashed(input.id, input.nowMs as number | undefined))
      case 'vfs_restore':
        if (typeof input.id !== 'string') {
          return bridgeFail('vfs.mcp_invalid_input', 'MCP restore requires a resource id.')
        }
        return bridgeOk(context.catalog.restore(input.id))
      case 'vfs_purge_trash':
        return bridgeOk(context.catalog.purgeTrashed(input.nowMs as number | undefined))
      case 'vfs_export_package': {
        const refs = refsFrom(input.refs)
        if (!refs.ok) return refs
        return context.vfs.exportPackage(refs.data, input.options as VfsExportPackageOptions)
      }
      case 'vfs_import_package':
        return context.vfs.importPackage(
          input.package as VfsPackage,
          input.options as VfsImportPackageOptions | undefined
        )
      case 'vfs_plugin_list':
        return bridgeOk(context.plugins?.list() || [])
      case 'vfs_plugin_match':
        return bridgeOk(context.plugins?.match(input.input as never) || [])
      case 'vfs_plugin_run': {
        if (!context.plugins)
          return bridgeFail('vfs.plugin_not_found', 'No VFS plugin registry is configured.')
        const ref = refFrom(input.ref)
        if (!ref.ok) return ref
        const stat = await context.vfs.stat(ref.data)
        if (!stat.ok) return stat
        return context.plugins.run(input.pluginId as string, { entry: stat.data })
      }
      case 'vfs_signed_url': {
        const ref = refFrom(input.ref)
        if (!ref.ok) return ref
        if (!context.signedUrl) {
          return bridgeFail('vfs.mcp_unavailable', 'Signed VFS URL settings are not configured.')
        }
        return createVfsSignedUrl(ref.data, {
          ...context.signedUrl,
          route: input.route as VfsWebRoute | undefined,
          expiresAtMs: (input.expiresAtMs as number | undefined) ?? context.signedUrl.expiresAtMs
        })
      }
      case 'vfs_jobs':
        return bridgeOk(context.jobs?.() || [])
      default:
        return bridgeFail('vfs.mcp_unknown_tool', 'Unknown VFS MCP tool.', { toolName })
    }
  }

  return async (toolName, input) => {
    if (!context.performance) return handle(toolName, input)
    return context.performance.measureAsync(
      {
        operation: 'vfs.mcp.tool',
        toolName,
        root:
          isRecord(input.ref) && typeof input.ref.root === 'string'
            ? input.ref.root
            : typeof input.root === 'string'
              ? input.root
              : undefined
      },
      () => handle(toolName, input)
    )
  }
}

export async function callVfsMcpTool(
  handler: VfsMcpHandler,
  toolName: VfsMcpToolName,
  input: Record<string, unknown>
): Promise<VfsMcpToolResponse> {
  const result = await handler(toolName, input)
  const structuredContent = result.ok ? result.data : result.error
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: !result.ok
  }
}
