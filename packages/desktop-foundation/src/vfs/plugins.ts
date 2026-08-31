import type { ApiResult } from '../contracts'
import { bridgeFail, bridgeOk } from '../bridge'
import type { ResourceRecord, VersionedResourceMetadata, VfsEntry } from '../vfs'
import { getExtension } from '../vfs'

export type AssetParserCapability =
  | 'metadata'
  | 'dependencies'
  | 'thumbnail'
  | 'preview'
  | 'transcode'
  | 'validate-import'
  | 'package-metadata'

export interface AssetDirectorySignature {
  requiredFileNames?: string[]
  requiredExtensions?: string[]
  namePattern?: RegExp
}

export interface AssetParserInput {
  entry: VfsEntry
  resource?: ResourceRecord
  siblingNames?: string[]
}

export interface AssetParserOutput {
  metadata: Record<string, unknown>
  dependencies?: string[]
  derivatives?: Array<{
    kind: 'thumbnail' | 'preview' | 'proxy' | 'histogram' | 'sidecar'
    path: string
  }>
}

export interface AssetParserPlugin {
  id: string
  displayName: string
  version: string
  outputSchemaVersion: string
  supportedExtensions?: string[]
  mimeTypes?: string[]
  directorySignatures?: AssetDirectorySignature[]
  capabilities: AssetParserCapability[]
  parse?: (input: AssetParserInput) => Promise<AssetParserOutput> | AssetParserOutput
}

export interface AssetParserMatchInput {
  path: string
  contentType?: string
  type?: VfsEntry['type']
  siblingNames?: string[]
}

export interface AssetParserRegistry {
  register(plugin: AssetParserPlugin): ApiResult<AssetParserPlugin>
  list(): AssetParserPlugin[]
  match(input: AssetParserMatchInput): AssetParserPlugin[]
  run(
    pluginId: string,
    input: AssetParserInput,
    nowMs?: number
  ): Promise<ApiResult<VersionedResourceMetadata>>
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, '').toLowerCase()
}

function matchesDirectorySignature(
  signature: AssetDirectorySignature,
  input: AssetParserMatchInput
): boolean {
  const siblingNames = input.siblingNames || []
  const lowerNames = siblingNames.map((name) => name.toLowerCase())
  const requiredNames = signature.requiredFileNames || []
  const requiredExtensions = signature.requiredExtensions?.map(normalizeExtension) || []

  return (
    (signature.namePattern === undefined || signature.namePattern.test(input.path)) &&
    requiredNames.every((name) => lowerNames.includes(name.toLowerCase())) &&
    requiredExtensions.every((extension) =>
      lowerNames.some((name) => getExtension(name) === extension)
    )
  )
}

export function createAssetParserRegistry(
  initialPlugins: AssetParserPlugin[] = []
): AssetParserRegistry {
  const plugins = new Map<string, AssetParserPlugin>()

  const registry: AssetParserRegistry = {
    register(plugin) {
      if (!plugin.id || !plugin.version || !plugin.outputSchemaVersion) {
        return bridgeFail('vfs.plugin_invalid', 'Asset parser plugin is missing identity fields.')
      }
      if (plugins.has(plugin.id)) {
        return bridgeFail('vfs.plugin_duplicate', 'Asset parser plugin id is already registered.', {
          pluginId: plugin.id
        })
      }
      const normalized: AssetParserPlugin = {
        ...plugin,
        supportedExtensions: plugin.supportedExtensions?.map(normalizeExtension)
      }
      plugins.set(plugin.id, normalized)
      return bridgeOk(normalized)
    },
    list() {
      return [...plugins.values()].map((plugin) => ({ ...plugin }))
    },
    match(input) {
      const extension = normalizeExtension(getExtension(input.path))
      return [...plugins.values()].filter((plugin) => {
        const extensionMatch =
          extension !== '' && plugin.supportedExtensions?.includes(extension) === true
        const mimeMatch =
          input.contentType !== undefined && plugin.mimeTypes?.includes(input.contentType) === true
        const directoryMatch =
          input.type === 'directory' &&
          plugin.directorySignatures?.some((signature) =>
            matchesDirectorySignature(signature, input)
          ) === true
        return extensionMatch || mimeMatch || directoryMatch
      })
    },
    async run(pluginId, input, nowMs = Date.now()) {
      const plugin = plugins.get(pluginId)
      if (!plugin) {
        return bridgeFail('vfs.plugin_not_found', 'Asset parser plugin is not registered.', {
          pluginId
        })
      }
      if (!plugin.parse) {
        return bridgeOk({
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          schemaVersion: plugin.outputSchemaVersion,
          status: 'ready',
          updatedAtMs: nowMs,
          data: {}
        })
      }

      try {
        const output = await plugin.parse(input)
        return bridgeOk({
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          schemaVersion: plugin.outputSchemaVersion,
          status: 'ready',
          updatedAtMs: nowMs,
          data: {
            ...output.metadata,
            dependencies: output.dependencies,
            derivatives: output.derivatives
          }
        })
      } catch (error) {
        return bridgeOk({
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          schemaVersion: plugin.outputSchemaVersion,
          status: 'failed',
          updatedAtMs: nowMs,
          data: {},
          errorCode: error instanceof Error ? error.name : 'ParserError'
        })
      }
    }
  }

  for (const plugin of initialPlugins) registry.register(plugin)
  return registry
}
