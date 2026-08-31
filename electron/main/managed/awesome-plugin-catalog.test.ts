import { describe, expect, it } from 'vitest'
import { parsePluginCatalogEntry } from './awesome-plugin-catalog'

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
})
