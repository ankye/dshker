import { readFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * The overlay the Launcher passes to `dsh web --patch`. A paired computer opens
 * this DSH over P2P, so the directory picker must render in the requesting page
 * rather than as a native chooser on this computer's screen.
 */
describe('Launcher DSH Web overlay', () => {
  it('pins the in-page browse directory picker instead of the native chooser', async () => {
    const source = await readFile(
      nodePath.join(__dirname, '../../../resources/dsh-launcher-verbose-logging.patch.yml'),
      'utf8'
    )
    const patches = load(source) as Array<Record<string, unknown>>
    expect(patches).toContainEqual({ id: 'directory-picker', disabled: true })
    const inserted = patches.flatMap(
      (patch) => (patch.insert as Array<{ id: string; name: string }> | undefined) ?? []
    )
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
})
