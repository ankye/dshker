import { describe, expect, it } from 'vitest'
import { createJsonRepository, defineValidator } from './runtime'
import {
  createDefaultVfsRoots,
  createMemoryVfs,
  createResourceCatalog,
  createVfsRepositoryStorage
} from './vfs'
import { createAssetParserRegistry } from './vfs/plugins'
import { createVfsSignedUrl, resolveVfsServiceRequest } from './vfs/service'

interface NoteRecord {
  id: string
  title: string
}

const noteValidator = defineValidator<NoteRecord>(
  (value): value is NoteRecord =>
    Boolean(
      value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'title' in value &&
      typeof value.title === 'string'
    ),
  'Invalid note record.'
)

describe('vfs resource e2e', () => {
  it('stores typed repository records through a VFS-backed adapter', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const vfs = createMemoryVfs(roots, { clock: () => 3000 })
    const repository = createJsonRepository({
      namespace: 'notes',
      storage: createVfsRepositoryStorage(vfs, 'projects'),
      validate: noteValidator
    })

    await expect(repository.save({ id: '1', title: 'VFS note' })).resolves.toEqual({
      ok: true,
      data: { id: '1', title: 'VFS note' }
    })
    await expect(repository.get('1')).resolves.toEqual({
      ok: true,
      data: { id: '1', title: 'VFS note' }
    })
    await expect(vfs.list('projects', 'notes')).resolves.toMatchObject({
      ok: true,
      data: [{ ref: { path: 'notes/1.json' }, updatedAtMs: 3000 }]
    })
  })

  it('moves package, parser, catalog, and web-service access through one resource flow', async () => {
    const roots = createDefaultVfsRoots('<app-data>')
    const catalog = createResourceCatalog()
    const vfs = createMemoryVfs(roots, { clock: () => 4000, catalog })
    const parsers = createAssetParserRegistry([
      {
        id: 'sequence-frame',
        displayName: 'Sequence Frames',
        version: '1.0.0',
        outputSchemaVersion: 'sequence-v1',
        directorySignatures: [{ namePattern: /run$/, requiredExtensions: ['png'] }],
        capabilities: ['metadata', 'thumbnail'],
        parse: (input) => ({
          metadata: {
            frameFolder: input.entry.ref.path,
            frameCount: input.siblingNames?.length ?? 0
          }
        })
      }
    ])

    await vfs.writeText({ root: 'projects', path: 'shots/run/frame-0001.png' }, 'frame-1')
    await vfs.writeText({ root: 'projects', path: 'shots/run/frame-0002.png' }, 'frame-2')

    const exported = await vfs.exportPackage([{ root: 'projects', path: 'shots/run' }], {
      packageId: 'pkg-run'
    })
    expect(exported).toMatchObject({ ok: true })
    if (!exported.ok) throw new Error('package export failed')

    const imported = await vfs.importPackage(exported.data, {
      targetRoot: 'imports',
      pathPrefix: 'library'
    })
    expect(imported).toMatchObject({ ok: true })
    if (!imported.ok) throw new Error('package import failed')
    expect(imported.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'library/run/frame-0001.png' }),
        expect.objectContaining({ path: 'library/run/frame-0002.png' })
      ])
    )

    const folder = await vfs.ensureDirectory({ root: 'imports', path: 'library/run' })
    expect(folder).toMatchObject({ ok: true })
    if (!folder.ok) throw new Error('directory failed')

    const matches = parsers.match({
      path: 'library/run',
      type: 'directory',
      siblingNames: ['frame-0001.png', 'frame-0002.png']
    })
    expect(matches.map((plugin) => plugin.id)).toEqual(['sequence-frame'])
    await expect(
      parsers.run('sequence-frame', {
        entry: folder.data,
        siblingNames: ['frame-0001.png', 'frame-0002.png']
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { status: 'ready', data: { frameCount: 2 } }
    })

    const signedUrl = createVfsSignedUrl(
      { root: 'imports', path: 'library/run/frame-0001.png' },
      { origin: 'http://127.0.0.1:4321', token: 'resource-token', expiresAtMs: 5000 }
    )
    expect(signedUrl).toMatchObject({ ok: true })
    if (!signedUrl.ok) throw new Error('signed url failed')
    await expect(
      resolveVfsServiceRequest(
        {
          vfs,
          catalog,
          nowMs: () => 4500,
          authorize: (request) => request.url.includes('resource-token')
        },
        { method: 'GET', url: signedUrl.data }
      )
    ).resolves.toMatchObject({
      ok: true,
      data: { ref: { root: 'imports', path: 'library/run/frame-0001.png' } }
    })
  })
})
