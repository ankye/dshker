import { describe, expect, it } from 'vitest'
import {
  assertVfsPermission,
  assertVfsWritable,
  createDefaultVfsRoots,
  createMemoryVfs,
  createProjectResourceManifest,
  createProjectResourceRef,
  createResourceCatalog,
  createResourceRecord,
  createVfsRepositoryStorage,
  createVfsRef,
  fingerprintContent,
  normalizeVfsPath,
  parseVfsWebUrl,
  parseVfsUri,
  resolveVfsPath,
  toVfsWebUrl,
  toVfsUri,
  validateProjectResourceManifest
} from './vfs'
import { createJsonRepository, defineValidator } from './runtime'
import { VFS_MCP_TOOLS, callVfsMcpTool, createVfsMcpHandler } from './vfs/mcp'
import { createVfsPerformanceProbe, evaluateVfsPerformanceBudgets } from './vfs/performance'
import { createAssetParserRegistry } from './vfs/plugins'
import {
  DEFAULT_VFS_SERVICE_ROUTES,
  createVfsSignedUrl,
  resolveVfsServiceRequest,
  serializeResourceForWeb
} from './vfs/service'

describe('vfs and resources', () => {
  it('resolves approved roots and rejects escape attempts', () => {
    const roots = createDefaultVfsRoots('<app-data>')

    expect(resolveVfsPath(roots, 'projects', 'demo/project.json')).toEqual({
      ok: true,
      data: {
        root: 'projects',
        path: 'demo/project.json',
        fullPath: '<app-data>/projects/demo/project.json',
        segments: ['demo', 'project.json'],
        mutable: true
      }
    })
    expect(normalizeVfsPath('../settings.json')).toMatchObject({
      ok: false,
      error: { code: 'vfs.invalid_path' }
    })
    expect(resolveVfsPath(roots, 'projects', '/absolute/path')).toMatchObject({
      ok: false,
      error: { code: 'vfs.invalid_path' }
    })
    expect(normalizeVfsPath('bad:name.txt')).toMatchObject({
      ok: false,
      error: { code: 'vfs.invalid_path' }
    })
    expect(createVfsRef('projects', 'Scene 1/main.json')).toMatchObject({
      ok: true,
      data: { root: 'projects', path: 'Scene 1/main.json' }
    })
    expect(toVfsUri({ root: 'projects', path: 'Scene 1/main.json' })).toEqual({
      ok: true,
      data: 'vfs://projects/Scene%201/main.json'
    })
    expect(parseVfsUri('vfs://projects/Scene%201/main.json')).toEqual({
      ok: true,
      data: { root: 'projects', path: 'Scene 1/main.json' }
    })
  })

  it('rejects writes to immutable packaged assets', () => {
    const roots = createDefaultVfsRoots('<app-data>')

    expect(assertVfsWritable(roots, { root: 'assets', path: 'logo.png' })).toMatchObject({
      ok: false,
      error: { code: 'vfs.immutable_root' }
    })
    expect(assertVfsPermission(roots, 'assets', 'read')).toMatchObject({
      ok: true
    })
    expect(assertVfsPermission(roots, 'assets', 'write')).toMatchObject({
      ok: false,
      error: { code: 'vfs.immutable_root' }
    })
  })

  it('reads, writes, lists, imports, exports, and deletes through typed VFS operations', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 1000, catalog })

    await expect(
      vfs.writeText({ root: 'projects', path: 'demo/project.json' }, '{"name":"Demo"}')
    ).resolves.toMatchObject({
      ok: true,
      data: {
        ref: { root: 'projects', path: 'demo/project.json' },
        size: 15,
        updatedAtMs: 1000
      }
    })
    await expect(vfs.readText({ root: 'projects', path: 'demo/project.json' })).resolves.toEqual({
      ok: true,
      data: '{"name":"Demo"}'
    })
    await expect(vfs.list('projects', 'demo')).resolves.toMatchObject({
      ok: true,
      data: [{ ref: { path: 'demo/project.json' } }]
    })
    await expect(vfs.exportText({ root: 'projects', path: 'demo/project.json' })).resolves.toEqual({
      ok: true,
      data: { name: 'project.json', content: '{"name":"Demo"}' }
    })
    await expect(
      vfs.importText({ root: 'imports', path: 'sprites/hero.png' }, 'png-bytes')
    ).resolves.toMatchObject({
      ok: true,
      data: {
        id: 'imports:sprites/hero.png',
        origin: 'imported',
        root: 'imports',
        mutable: true
      }
    })
    expect(catalog.get('imports:sprites/hero.png')).toMatchObject({
      fingerprint: fingerprintContent('png-bytes')
    })
    await vfs.delete({ root: 'projects', path: 'demo/project.json' })
    await expect(
      vfs.readText({ root: 'projects', path: 'demo/project.json' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'vfs.not_found' }
    })
  })

  it('keeps directory structure for recursive list, copy, and move', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const vfs = createMemoryVfs(roots, { clock: () => 1000 })

    await vfs.writeText({ root: 'projects', path: 'source/scenes/intro.json' }, 'intro')
    await vfs.writeText({ root: 'projects', path: 'source/assets/ui/button.png' }, 'button')

    const recursiveList = await vfs.list('projects', 'source', {
      recursive: true
    })
    expect(recursiveList).toMatchObject({ ok: true })
    if (!recursiveList.ok) throw new Error('recursive list failed')
    expect(recursiveList.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { root: 'projects', path: 'source/scenes/intro.json' }
        }),
        expect.objectContaining({
          ref: { root: 'projects', path: 'source/assets/ui/button.png' }
        })
      ])
    )
    await expect(
      vfs.copy({ root: 'projects', path: 'source' }, { root: 'exports', path: 'snapshot/source' })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        ref: { root: 'exports', path: 'snapshot/source' },
        type: 'directory'
      }
    })
    await expect(
      vfs.readText({
        root: 'exports',
        path: 'snapshot/source/scenes/intro.json'
      })
    ).resolves.toEqual({
      ok: true,
      data: 'intro'
    })
    await expect(
      vfs.readText({
        root: 'exports',
        path: 'snapshot/source/assets/ui/button.png'
      })
    ).resolves.toEqual({
      ok: true,
      data: 'button'
    })
    await expect(
      vfs.move(
        { root: 'exports', path: 'snapshot/source' },
        { root: 'exports', path: 'archive/source' }
      )
    ).resolves.toMatchObject({
      ok: true,
      data: { ref: { path: 'archive/source' } }
    })
    await expect(
      vfs.exists({
        root: 'exports',
        path: 'snapshot/source/scenes/intro.json'
      })
    ).resolves.toEqual({
      ok: true,
      data: false
    })
    await expect(
      vfs.exists({ root: 'exports', path: 'archive/source/scenes/intro.json' })
    ).resolves.toEqual({
      ok: true,
      data: true
    })
    await expect(
      vfs.copy({ root: 'projects', path: 'source' }, { root: 'projects', path: 'source/nested' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'vfs.invalid_target' }
    })
  })

  it('defines project resource manifests on top of the shared VFS contract', async () => {
    const manifest = createProjectResourceManifest('demo-project', {
      nowMs: 1000,
      metadata: { title: 'Demo Project' }
    })
    expect(manifest).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        projectId: 'demo-project',
        projectRef: { root: 'projects', path: 'demo-project' },
        projectFileRef: { root: 'projects', path: 'demo-project/project.json' },
        resourcesRef: { root: 'projects', path: 'demo-project/resources' },
        catalog: {
          root: 'projects',
          resourcePathPrefix: 'demo-project/resources',
          moveStrategy: 'catalog-prefix-update'
        },
        package: {
          preserveRelativePaths: true,
          defaultExportRef: {
            root: 'projects',
            path: 'demo-project/resources/packages'
          }
        },
        web: { safeUrlRequired: true },
        mcp: { scope: 'project:demo-project', allowedRoots: ['projects'] }
      }
    })
    if (!manifest.ok) throw new Error('project manifest failed')
    expect(manifest.data.folders.source.ref).toEqual({
      root: 'projects',
      path: 'demo-project/resources/source'
    })
    expect(manifest.data.folders.imports.ref).toEqual({
      root: 'projects',
      path: 'demo-project/resources/imports'
    })
    expect(manifest.data.folders.manifests.ref).toEqual({
      root: 'projects',
      path: 'demo-project/metadata/manifests'
    })
    expect(validateProjectResourceManifest(manifest.data)).toEqual({
      ok: true,
      data: manifest.data
    })

    expect(createProjectResourceRef('demo-project', 'source', 'characters/hero.psd')).toEqual({
      ok: true,
      data: {
        root: 'projects',
        path: 'demo-project/resources/source/characters/hero.psd'
      }
    })
    expect(createProjectResourceRef('demo-project/nested', 'source')).toMatchObject({
      ok: false,
      error: { code: 'vfs.invalid_project_id' }
    })

    const invalidManifest = {
      ...manifest.data,
      folders: {
        ...manifest.data.folders,
        source: {
          ...manifest.data.folders.source,
          ref: {
            root: 'imports' as const,
            path: 'demo-project/resources/source'
          }
        }
      }
    }
    expect(validateProjectResourceManifest(invalidManifest)).toMatchObject({
      ok: false,
      error: { code: 'vfs.project_manifest_invalid' }
    })
  })

  it('supports directories, stat, bytes, atomic writes, quotas, and dry-run cleanup', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const vfs = createMemoryVfs(roots, {
      clock: () => 1000,
      policy: { maxFileBytes: { projects: 4 } }
    })

    await expect(
      vfs.ensureDirectory({ root: 'projects', path: 'demo/assets' })
    ).resolves.toMatchObject({
      ok: true,
      data: { type: 'directory', ref: { path: 'demo/assets' } }
    })
    await expect(
      vfs.writeBytes({ root: 'projects', path: 'demo/assets/a.bin' }, new Uint8Array([1, 2, 3, 4]))
    ).resolves.toMatchObject({
      ok: true,
      data: { size: 4 }
    })
    await expect(vfs.stat({ root: 'projects', path: 'demo/assets/a.bin' })).resolves.toMatchObject({
      ok: true,
      data: { type: 'file', size: 4 }
    })
    await expect(
      vfs.readBytes({ root: 'projects', path: 'demo/assets/a.bin' })
    ).resolves.toMatchObject({
      ok: true,
      data: new Uint8Array([1, 2, 3, 4])
    })
    await expect(
      vfs.writeTextAtomic({ root: 'projects', path: 'demo/assets/b.txt' }, '12345')
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'vfs.file_too_large' }
    })

    const cleanup = await vfs.cleanup({ roots: ['projects'], dryRun: true })
    expect(cleanup).toMatchObject({ ok: true })
    await expect(vfs.exists({ root: 'projects', path: 'demo/assets/a.bin' })).resolves.toEqual({
      ok: true,
      data: true
    })
  })

  it('creates resource metadata and catalog records', () => {
    const catalog = createResourceCatalog()
    const record = catalog.upsert(
      createResourceRecord({
        id: 'asset:logo',
        type: 'image',
        origin: 'packaged',
        content: 'logo',
        root: 'assets',
        path: 'logo.png',
        mutable: false,
        nowMs: 2000,
        projectId: 'demo',
        tags: ['brand']
      })
    )

    expect(record).toMatchObject({
      id: 'asset:logo',
      fingerprint: fingerprintContent('logo'),
      size: 4,
      createdAtMs: 2000,
      mutable: false
    })
    expect(catalog.find({ projectId: 'demo', tag: 'brand' })).toHaveLength(1)
    expect(catalog.count({ root: 'assets' })).toBe(1)
    expect(catalog.findPage({ limit: 1 })).toMatchObject({
      items: [{ id: 'asset:logo' }],
      total: 1
    })
    expect(catalog.list()).toHaveLength(1)
    catalog.remove('asset:logo')
    expect(catalog.get('asset:logo')).toBeUndefined()
  })

  it('pages large directories and catalogs without requiring full UI loads', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 1000, catalog })
    const imports = Array.from({ length: 2500 }, (_, index) => ({
      ref: {
        root: 'imports' as const,
        path: `library/set-${Math.floor(index / 100)}/asset-${index}.png`
      },
      content: `asset-${index}`,
      options: { type: 'image', tags: ['imported'] }
    }))

    await expect(vfs.importManyText(imports)).resolves.toMatchObject({
      ok: true,
      data: expect.any(Array)
    })
    expect(catalog.count({ root: 'imports', tag: 'imported' })).toBe(2500)

    const firstPage = await vfs.listPage('imports', 'library', {
      recursive: true,
      limit: 1000
    })
    expect(firstPage).toMatchObject({
      ok: true,
      data: {
        items: expect.any(Array),
        nextCursor: '1000',
        total: expect.any(Number)
      }
    })
    if (!firstPage.ok) throw new Error('listPage failed')
    expect(firstPage.data.items).toHaveLength(1000)
    expect(firstPage.data.items[0].ref.path).toBe('library/set-0')

    const catalogPage = catalog.findPage({
      root: 'imports',
      tag: 'imported',
      limit: 750
    })
    expect(catalogPage.items).toHaveLength(750)
    expect(catalogPage.nextCursor).toBe('750')
    expect(catalogPage.total).toBe(2500)
  })

  it('creates web-safe VFS URLs and resolves service requests without exposing local paths', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 1000, catalog })
    await vfs.writeText({ root: 'imports', path: 'video/demo.mp4' }, 'video')

    const webUrl = toVfsWebUrl(
      { root: 'imports', path: 'video/demo.mp4' },
      {
        origin: 'http://127.0.0.1:4123',
        route: 'stream',
        token: 'signed-token',
        expiresAtMs: 5000
      }
    )
    expect(webUrl).toMatchObject({ ok: true })
    if (!webUrl.ok) throw new Error('web url failed')
    expect(webUrl.data).toContain('/vfs/stream/imports/video/demo.mp4')
    expect(webUrl.data).not.toContain('<app-data>')

    expect(parseVfsWebUrl(webUrl.data)).toEqual({
      ok: true,
      data: {
        ref: { root: 'imports', path: 'video/demo.mp4' },
        route: 'stream',
        token: 'signed-token',
        expiresAtMs: 5000
      }
    })

    const resolved = await resolveVfsServiceRequest(
      {
        vfs,
        catalog,
        nowMs: () => 2000,
        authorize: (request) => request.url.includes('signed-token')
      },
      { method: 'GET', url: webUrl.data }
    )
    expect(resolved).toMatchObject({
      ok: true,
      data: {
        ref: { root: 'imports', path: 'video/demo.mp4' },
        entry: { type: 'file' }
      }
    })

    const signedUrl = createVfsSignedUrl(
      { root: 'imports', path: 'video/demo.mp4' },
      {
        origin: 'app://vfs',
        token: 'token',
        expiresAtMs: 3000,
        route: 'download'
      }
    )
    expect(signedUrl).toMatchObject({ ok: true })
    expect(DEFAULT_VFS_SERVICE_ROUTES.some((route) => route.capability === 'stream')).toBe(true)
  })

  it('exposes VFS MCP tools with safe responses and performance metrics', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 1000, catalog })
    const performance = createVfsPerformanceProbe(() => 2000)
    const handler = createVfsMcpHandler({
      roots,
      vfs,
      catalog,
      performance,
      signedUrl: {
        origin: 'http://127.0.0.1:4123',
        token: 'mcp-token',
        expiresAtMs: 5000
      }
    })

    expect(VFS_MCP_TOOLS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'vfs_roots',
        'vfs_list_page',
        'vfs_catalog_query',
        'vfs_smart_folder_query',
        'vfs_export_package',
        'vfs_plugin_run',
        'vfs_signed_url',
        'vfs_jobs'
      ])
    )

    await expect(
      handler('vfs_write_text', {
        ref: { root: 'imports', path: 'notes/info.txt' },
        content: 'hello',
        contentType: 'text/plain'
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { ref: { root: 'imports', path: 'notes/info.txt' } }
    })
    await expect(
      handler('vfs_read_text', {
        ref: { root: 'imports', path: 'notes/info.txt' }
      })
    ).resolves.toEqual({ ok: true, data: 'hello' })
    const mcpRecord = catalog.upsert(
      createResourceRecord({
        id: 'imports:notes/info.txt',
        type: 'text',
        origin: 'imported',
        content: 'hello',
        root: 'imports',
        path: 'notes/info.txt',
        mutable: true,
        tags: ['mcp'],
        rating: 4,
        nowMs: 1000
      })
    )
    await expect(
      handler('vfs_smart_folder_query', {
        folder: { id: 'mcp', name: 'MCP', filter: { tag: 'mcp', limit: 10 } }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        items: [expect.objectContaining({ id: mcpRecord.id })],
        total: 1
      }
    })
    await expect(handler('vfs_trash', { id: mcpRecord.id, nowMs: 2100 })).resolves.toMatchObject({
      ok: true,
      data: { id: mcpRecord.id, trashedAtMs: 2100 }
    })
    await expect(handler('vfs_restore', { id: mcpRecord.id })).resolves.toMatchObject({
      ok: true,
      data: { id: mcpRecord.id, trashedAtMs: undefined }
    })

    const signed = await handler('vfs_signed_url', {
      ref: { root: 'imports', path: 'notes/info.txt' },
      route: 'download'
    })
    expect(signed).toMatchObject({ ok: true })
    if (!signed.ok || typeof signed.data !== 'string') throw new Error('signed URL failed')
    expect(signed.data).toContain('mcp-token')
    expect(signed.data).not.toContain('<app-data>')

    const response = await callVfsMcpTool(handler, 'vfs_list_page', {
      root: 'imports',
      dir: 'notes',
      limit: 10
    })
    expect(response.isError).toBeFalsy()
    expect(response.structuredContent).toMatchObject({
      items: [
        expect.objectContaining({
          ref: { root: 'imports', path: 'notes/info.txt' }
        })
      ]
    })

    const metrics = performance.snapshot()
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'vfs.mcp.tool',
          toolName: 'vfs_write_text',
          root: 'imports',
          status: 'ok'
        }),
        expect.objectContaining({
          operation: 'vfs.mcp.tool',
          toolName: 'vfs_list_page'
        })
      ])
    )
    expect(
      evaluateVfsPerformanceBudgets(metrics, [{ operation: 'vfs.mcp.tool', p95Ms: 1000 }])
    ).toMatchObject([{ ok: true, operation: 'vfs.mcp.tool', sampleCount: expect.any(Number) }])
  })

  it('registers asset parser plugins and isolates parser failures', async () => {
    const registry = createAssetParserRegistry([
      {
        id: 'spine',
        displayName: 'Spine',
        version: '1.0.0',
        outputSchemaVersion: 'spine-meta-v1',
        supportedExtensions: ['json', 'skel'],
        directorySignatures: [{ requiredExtensions: ['atlas', 'png'] }],
        capabilities: ['metadata', 'dependencies', 'thumbnail'],
        parse: () => ({
          metadata: { skeleton: true, animations: 3 },
          dependencies: ['hero.atlas', 'hero.png']
        })
      },
      {
        id: 'broken',
        displayName: 'Broken Parser',
        version: '1.0.0',
        outputSchemaVersion: 'broken-v1',
        supportedExtensions: ['psd'],
        capabilities: ['metadata'],
        parse: () => {
          throw new Error('parser failed')
        }
      }
    ])

    expect(registry.match({ path: 'hero/hero.json' }).map((plugin) => plugin.id)).toContain('spine')
    expect(
      registry.match({
        path: 'hero',
        type: 'directory',
        siblingNames: ['hero.atlas', 'hero.png', 'hero.skel']
      })
    ).toHaveLength(1)

    await expect(
      registry.run('spine', {
        entry: {
          ref: { root: 'imports', path: 'hero/hero.json' },
          uri: 'vfs://imports/hero/hero.json',
          fullPath: '<app-data>/imports/hero/hero.json',
          size: 1,
          createdAtMs: 1000,
          updatedAtMs: 1000,
          type: 'file'
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: {
        pluginId: 'spine',
        pluginVersion: '1.0.0',
        schemaVersion: 'spine-meta-v1',
        status: 'ready',
        data: { skeleton: true, animations: 3 }
      }
    })

    await expect(
      registry.run('broken', {
        entry: {
          ref: { root: 'imports', path: 'mock.psd' },
          uri: 'vfs://imports/mock.psd',
          fullPath: '<app-data>/imports/mock.psd',
          size: 1,
          createdAtMs: 1000,
          updatedAtMs: 1000,
          type: 'file'
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { pluginId: 'broken', status: 'failed', errorCode: 'Error' }
    })
  })

  it('exports and imports packages with preserved relative paths and fingerprint checks', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 1000, catalog })

    await vfs.writeText({ root: 'projects', path: 'source/scenes/intro.json' }, 'intro')
    await vfs.writeText({ root: 'projects', path: 'source/assets/ui/button.png' }, 'button')

    const exported = await vfs.exportPackage([{ root: 'projects', path: 'source' }], {
      packageId: 'pkg-demo',
      nowMs: 2000,
      metadata: { app: 'demo' }
    })
    expect(exported).toMatchObject({
      ok: true,
      data: { manifest: { schemaVersion: 1, packageId: 'pkg-demo' } }
    })
    if (!exported.ok) throw new Error('export package failed')
    expect(exported.data.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: 'source/scenes/intro.json' }),
        expect.objectContaining({
          relativePath: 'source/assets/ui/button.png'
        })
      ])
    )

    const imported = await vfs.importPackage(exported.data, {
      targetRoot: 'imports',
      pathPrefix: 'incoming'
    })
    expect(imported).toMatchObject({ ok: true })
    if (!imported.ok) throw new Error('import package failed')
    expect(imported.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: 'imports',
          path: 'incoming/source/scenes/intro.json'
        }),
        expect.objectContaining({
          root: 'imports',
          path: 'incoming/source/assets/ui/button.png'
        })
      ])
    )
    await expect(
      vfs.readText({
        root: 'imports',
        path: 'incoming/source/scenes/intro.json'
      })
    ).resolves.toEqual({
      ok: true,
      data: 'intro'
    })

    const brokenPackage = {
      ...exported.data,
      files: [{ ...exported.data.files[0], content: new Uint8Array([0]) }]
    }
    await expect(vfs.importPackage(brokenPackage)).resolves.toMatchObject({
      ok: false,
      error: { code: 'vfs.package_fingerprint_mismatch' }
    })
  })

  it('tracks duplicate fingerprints, virtual organization, path prefix moves, and trash state', () => {
    const catalog = createResourceCatalog()
    const first = catalog.upsert(
      createResourceRecord({
        id: 'imports:a/logo.png',
        type: 'image',
        origin: 'imported',
        content: 'same',
        root: 'imports',
        path: 'a/logo.png',
        mutable: true,
        tags: ['brand'],
        rating: 5,
        colorLabel: 'green',
        notes: 'Primary logo',
        favorite: true,
        virtualFolders: ['logos'],
        collections: ['launch'],
        importBatchId: 'batch-1'
      })
    )
    const second = catalog.upsert(
      createResourceRecord({
        id: 'imports:b/logo-copy.png',
        type: 'image',
        origin: 'imported',
        content: 'same',
        root: 'imports',
        path: 'b/logo-copy.png',
        mutable: true
      })
    )

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(catalog.findDuplicates(first.fingerprint)).toHaveLength(2)
    expect(catalog.find({ duplicateOf: first.id })).toEqual([second])
    expect(catalog.find({ virtualFolder: 'logos' })).toEqual([first])
    expect(catalog.findPage({ collection: 'launch', limit: 1 })).toMatchObject({
      items: [{ id: first.id }],
      total: 1
    })

    expect(catalog.movePathPrefix('imports', 'a', 'archive/a')).toBe(1)
    expect(catalog.get(first.id)).toMatchObject({
      id: first.id,
      path: 'archive/a/logo.png',
      fingerprint: first.fingerprint
    })

    expect(catalog.markTrashed(first.id, 3000)).toMatchObject({
      id: first.id,
      trashedAtMs: 3000
    })
    expect(catalog.find({ tag: 'brand' })).toHaveLength(0)
    expect(catalog.find({ tag: 'brand', includeTrashed: true })).toHaveLength(1)
    expect(catalog.restore(first.id)).toMatchObject({
      id: first.id,
      trashedAtMs: undefined
    })
    expect(serializeResourceForWeb(catalog.get(first.id)!)).toMatchObject({
      id: first.id,
      tags: ['brand'],
      virtualFolders: ['logos']
    })
  })

  it('supports smart folders, derivatives, import batches, external edits, and purge lifecycle', () => {
    const catalog = createResourceCatalog()
    const record = catalog.upsert(
      createResourceRecord({
        id: 'imports:hero/run.png',
        type: 'image',
        origin: 'imported',
        content: 'hero-v1',
        root: 'imports',
        path: 'hero/run.png',
        mutable: true,
        contentType: 'image/png',
        tags: ['hero'],
        rating: 5,
        colorLabel: 'blue',
        favorite: true,
        virtualFolders: ['characters'],
        collections: ['launch'],
        pluginMetadata: {
          image: {
            pluginId: 'image',
            pluginVersion: '1.0.0',
            schemaVersion: 'image-v1',
            status: 'ready',
            updatedAtMs: 1000,
            data: { width: 256, height: 256 }
          }
        },
        nowMs: 1000
      })
    )

    const smartFolder = catalog.querySmartFolder({
      id: 'high-rated-heroes',
      name: 'High Rated Heroes',
      filter: { tag: 'hero', ratingMin: 4, colorLabel: 'blue', limit: 10 },
      sort: [{ field: 'rating', direction: 'desc' }]
    })
    expect(smartFolder).toMatchObject({
      items: [{ id: record.id, path: 'hero/run.png' }],
      total: 1
    })
    expect(catalog.count({ pathPrefix: 'hero' })).toBe(1)

    expect(
      catalog.upsertDerivative(record.id, {
        id: 'thumb:hero',
        resourceId: record.id,
        kind: 'thumbnail',
        root: 'cache',
        path: 'thumbs/hero.webp',
        sourceFingerprint: record.fingerprint,
        pluginId: 'image',
        pluginVersion: '1.0.0',
        width: 256,
        height: 256,
        size: 512
      })
    ).toMatchObject({ id: record.id, derivatives: [{ id: 'thumb:hero' }] })
    expect(catalog.listDerivatives(record.id)).toHaveLength(1)
    expect(catalog.invalidateDerivatives(record.id, 2000)).toEqual([
      expect.objectContaining({ id: 'thumb:hero', invalidatedAtMs: 2000 })
    ])
    expect(catalog.cleanupInvalidDerivatives(2000)).toEqual([
      expect.objectContaining({ id: 'thumb:hero' })
    ])
    expect(catalog.listDerivatives(record.id)).toHaveLength(0)

    catalog.recordImportBatch({
      id: 'batch-web-1',
      sourceKind: 'browser-capture',
      createdAtMs: 2500,
      title: 'Hero reference',
      sourceUrl: 'https://example.test/hero.png',
      referrer: 'https://example.test/',
      licenseNote: 'internal reference',
      tags: ['web'],
      resourceIds: [record.id]
    })
    expect(catalog.getImportBatch('batch-web-1')).toMatchObject({
      id: 'batch-web-1',
      resourceIds: [record.id]
    })
    expect(catalog.get(record.id)).toMatchObject({
      importBatchId: 'batch-web-1',
      tags: ['hero', 'web'],
      source: { sourceKind: 'browser-capture', title: 'Hero reference' }
    })
    expect(catalog.find({ sourceKind: 'browser-capture' })).toHaveLength(1)

    catalog.upsertDerivative(record.id, {
      id: 'preview:hero',
      resourceId: record.id,
      kind: 'preview',
      root: 'cache',
      path: 'previews/hero.webp',
      sourceFingerprint: record.fingerprint,
      pluginId: 'image',
      pluginVersion: '1.0.0'
    })
    const reconciled = catalog.reconcileExternalChange(record.id, 'hero-v2', 3000)
    expect(reconciled).toMatchObject({
      id: record.id,
      size: 7,
      updatedAtMs: 3000,
      tags: ['hero', 'web'],
      collections: ['launch'],
      pluginMetadata: { image: { status: 'stale', updatedAtMs: 3000 } },
      derivatives: [{ id: 'preview:hero', invalidatedAtMs: 3000 }]
    })
    expect(reconciled?.fingerprint).not.toBe(record.fingerprint)

    expect(catalog.removeFromCollection(record.id, 'launch')).toMatchObject({
      id: record.id,
      collections: []
    })
    expect(catalog.get(record.id)?.trashedAtMs).toBeUndefined()
    expect(catalog.markTrashed(record.id, 4000)).toMatchObject({
      trashedAtMs: 4000
    })
    expect(catalog.find({ tag: 'hero' })).toHaveLength(0)
    expect(catalog.restore(record.id)).toMatchObject({
      id: record.id,
      trashedAtMs: undefined
    })
    catalog.markTrashed(record.id, 5000)
    expect(catalog.purgeTrashed(6000)).toEqual([
      expect.objectContaining({ id: record.id, deletedAtMs: 6000 })
    ])
    expect(catalog.get(record.id)).toBeUndefined()
  })

  it('backs repositories with VFS storage and preserves record directory paths', async () => {
    interface ProjectNote {
      id: string
      title: string
    }
    const validator = defineValidator<ProjectNote>((value): value is ProjectNote =>
      Boolean(
        value &&
        typeof value === 'object' &&
        'id' in value &&
        typeof value.id === 'string' &&
        'title' in value &&
        typeof value.title === 'string'
      )
    )
    const roots = createDefaultVfsRoots('<app-data>')
    const vfs = createMemoryVfs(roots, { clock: () => 1000 })
    const repository = createJsonRepository({
      namespace: 'projects/demo/notes',
      storage: createVfsRepositoryStorage(vfs, 'projects'),
      validate: validator
    })

    await repository.save({ id: 'intro', title: 'Intro' })
    await expect(
      vfs.exists({ root: 'projects', path: 'projects/demo/notes/intro.json' })
    ).resolves.toEqual({
      ok: true,
      data: true
    })
  })

  it('cleans cache and tmp while preserving user data, imports, logs, and exports', async () => {
    let now = 1000
    const roots = createDefaultVfsRoots('<app-data>')
    const vfs = createMemoryVfs(roots, { clock: () => now })

    await vfs.writeText({ root: 'projects', path: 'demo/project.json' }, 'project')
    await vfs.writeText({ root: 'imports', path: 'hero.png' }, 'import')
    await vfs.writeText({ root: 'cache', path: 'thumbs/hero.webp' }, 'cache')
    await vfs.writeText({ root: 'tmp', path: 'render.tmp' }, 'tmp')
    await vfs.writeText({ root: 'logs', path: 'app.log' }, 'log')
    await vfs.writeText({ root: 'exports', path: 'video.mp4' }, 'export')

    now = 5000
    const cleanup = await vfs.cleanup({ nowMs: now, maxAgeMs: 1000 })
    expect(cleanup).toMatchObject({ ok: true })
    if (!cleanup.ok) throw new Error('cleanup failed')
    expect(cleanup.data.removed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { root: 'cache', path: 'thumbs/hero.webp' },
          type: 'file'
        }),
        expect.objectContaining({
          ref: { root: 'tmp', path: 'render.tmp' },
          type: 'file'
        })
      ])
    )
    expect(cleanup.data.preserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { root: 'projects', path: 'demo/project.json' },
          type: 'file'
        }),
        expect.objectContaining({
          ref: { root: 'imports', path: 'hero.png' },
          type: 'file'
        }),
        expect.objectContaining({
          ref: { root: 'logs', path: 'app.log' },
          type: 'file'
        }),
        expect.objectContaining({
          ref: { root: 'exports', path: 'video.mp4' },
          type: 'file'
        })
      ])
    )
  })
})
