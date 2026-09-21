import type { ApiResult } from './contracts'
import type { RepositoryStorage } from './runtime'
import { bridgeFail, bridgeOk } from './bridge'
import {
  assertVfsPermission,
  basename,
  byteLength,
  fingerprintContent,
  getExtension,
  joinVfsPath,
  paginate,
  replacePrefix,
  resolveVfsPath,
  TEXT_DECODER,
  TEXT_ENCODER,
  toVfsUri
} from './vfs-paths'
import { createResourceCatalog, createResourceRecord } from './vfs-catalog'
import type {
  ResourceCatalog,
  ResourceRecord,
  ResolvedVfsPath,
  VfsBridge,
  VfsEntry,
  VfsPackage,
  VfsPackageFile,
  VfsPackageManifest,
  VfsRef,
  VfsRootId,
  VfsRootMap,
  VfsPolicy,
  VfsWriteOptions
} from './vfs-types'

interface StoredEntry {
  entry: VfsEntry
  content?: string | Uint8Array
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
