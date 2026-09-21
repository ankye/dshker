import {
  byteLength,
  fingerprintContent,
  getExtension,
  joinVfsPath,
  paginate,
  replacePrefix
} from './vfs-paths'
import type {
  ResourceAnnotation,
  ResourceCatalog,
  ResourceCatalogFilter,
  ResourceDerivativeRecord,
  ResourceImportBatch,
  ResourceImportProvenance,
  ResourceRecord,
  ResourceSmartFolder,
  VersionedResourceMetadata,
  VfsRootId
} from './vfs-types'

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
