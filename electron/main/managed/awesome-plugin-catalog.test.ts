import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { AwesomePluginCatalog, parsePluginCatalogEntry } from './awesome-plugin-catalog'

describe('parsePluginCatalogEntry', () => {
  it('projects the curated YAML fields shown by the installable-plugin list', () => {
    expect(
      parsePluginCatalogEntry(
        [
          'url: https://github.com/awesome/example-plugin',
          'name: awesome/example-plugin',
          'category: tools',
          'description:',
          '  en: Example plugin',
          '  zh: 示例插件'
        ].join('\n'),
        'awesome__example-plugin.yml'
      )
    ).toEqual({
      id: 'awesome__example-plugin',
      url: 'https://github.com/awesome/example-plugin',
      name: 'awesome/example-plugin',
      category: 'tools',
      description: '示例插件'
    })
  })

  it('rejects a catalog entry without the required English description', () => {
    expect(() =>
      parsePluginCatalogEntry(
        ['url: https://github.com/awesome/example-plugin', 'name: example', 'category: tools'].join(
          '\n'
        ),
        'invalid.yml'
      )
    ).toThrow('Plugin catalog entry invalid.yml is invalid.')
  })

  it('records the git command and failure output while keeping the existing catalog untouched', async () => {
    const root = await realpath(
      await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-plugin-catalog-'))
    )
    try {
      const pluginsDirectory = nodePath.join(root, 'plugins')
      await mkdir(pluginsDirectory)
      const activities: string[] = []
      const catalog = new AwesomePluginCatalog({
        pluginsDirectory,
        gitExecutable: process.execPath,
        onActivity: (message) => activities.push(message)
      })

      await expect(catalog.refresh()).rejects.toMatchObject({ code: expect.any(String) })
      await expect(catalog.getState()).resolves.toMatchObject({ kind: 'empty', entries: [] })

      const log = await readFile(nodePath.join(root, 'logs', 'plugin-catalog.log'), 'utf8')
      expect(log).toContain('Refreshing plugin catalog')
      expect(log).toContain('Git clone started:')
      expect(log).toContain('Git clone failed:')
      expect(log).toContain('git.command_failed')
      expect(activities).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Refreshing plugin catalog'),
          expect.stringContaining('Plugin catalog refresh failed:')
        ])
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
