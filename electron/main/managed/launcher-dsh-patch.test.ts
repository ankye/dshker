import { readFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const overlayPath = nodePath.join(
  __dirname,
  '../../../resources/dsh-launcher-verbose-logging.patch.yml'
)
const rootsPluginName = 'dshker-directory-roots'
const rootsPluginFile = 'dshker-directory-roots.mjs'

/** Every entry the overlay inserts, across its insert lists. */
async function insertedEntries(): Promise<Array<{ id: string; name: string }>> {
  const source = await readFile(overlayPath, 'utf8')
  const patches = load(source) as Array<Record<string, unknown>>
  return patches.flatMap(
    (patch) => (patch.insert as Array<{ id: string; name: string }> | undefined) ?? []
  )
}

/**
 * The overlay the Launcher passes to `dsh web --patch`. A paired computer opens
 * this DSH over P2P, so the directory picker must render in the requesting page
 * rather than as a native chooser on this computer's screen.
 */
describe('Launcher DSH Web overlay', () => {
  it('pins the in-page browse directory picker instead of the native chooser', async () => {
    const source = await readFile(overlayPath, 'utf8')
    const patches = load(source) as Array<Record<string, unknown>>
    expect(patches).toContainEqual({ id: 'directory-picker', disabled: true })
    const inserted = await insertedEntries()
    expect(inserted.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        '@deepseek-ai/dsh-host-directory-picker-browse',
        '@deepseek-ai/dsh-client-ui-directory-picker-browse'
      ])
    )
    expect(inserted.map((entry) => entry.name)).not.toContain(
      '@deepseek-ai/dsh-host-directory-picker-native'
    )
  })

  it('inserts the Launcher disk-root plugin by a path beside the overlay', async () => {
    const entries = await insertedEntries()
    const row = entries.find((entry) => entry.id === rootsPluginName)
    // The relative name is resolved against the overlay file's own directory by
    // DSH's patch loader, so the plugin must be named relative to that file.
    expect(row?.name).toBe(`./${rootsPluginFile}`)

    const plugin = await readFile(
      nodePath.join(nodePath.dirname(overlayPath), rootsPluginFile),
      'utf8'
    )
    expect(plugin).toContain(`export const name = '${rootsPluginName}'`)
    expect(plugin).toMatch(/export const inject = \['directoryPicker'\]/u)
    expect(plugin).toContain('export function apply(ctx)')
  })

  it('ships the overlay and the plugin as sibling application resources', async () => {
    const manifest = JSON.parse(
      await readFile(nodePath.join(__dirname, '../../../package.json'), 'utf8')
    ) as { build: { extraResources: Array<{ from: string; to?: string }> } }
    const shipped = manifest.build.extraResources.map((entry) => entry.from)
    // Packaging keeps the relative geometry the overlay relies on: both files
    // land beside each other in the application resources directory.
    expect(shipped).toContain('resources/dsh-launcher-verbose-logging.patch.yml')
    expect(shipped).toContain(`resources/${rootsPluginFile}`)
  })
})
