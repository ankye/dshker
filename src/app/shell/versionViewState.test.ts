import { describe, expect, it } from 'vitest'
import type { LauncherHarnessPluginView } from '@/shared/contracts'
import { installedExtensionGroupsOf, isSettingsUiPackage, versionView } from './versionViewState'

function plugin(
  name: string,
  options: Partial<LauncherHarnessPluginView> = {}
): LauncherHarnessPluginView {
  return {
    name,
    version: 'file:/managed/source',
    origin: 'user',
    ...options
  }
}

describe('installedExtensionGroupsOf', () => {
  it('merges a runtime tool and its settings UI from one source into one extension', () => {
    const groups = installedExtensionGroupsOf([
      plugin('@deepseek-ai/dsh-tool-image-generation', {
        sourceUrl: 'https://github.com/ankye/dsh-image-generation',
        localPath: '/work/dsh-image-generation/packages/tool-image-generation'
      }),
      plugin('@deepseek-ai/dsh-client-ui-image-generation', {
        sourceUrl: 'https://github.com/ankye/dsh-image-generation',
        localPath: '/work/dsh-image-generation/packages/ui-image-generation'
      }),
      plugin('@deepseek-ai/dsh-tool-use-browser', {
        sourceUrl: 'https://github.com/ankye/dsh_use_browser'
      }),
      plugin('@deepseek-ai/dsh-base', { origin: 'default', version: '' })
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      primaryPlugin: { name: '@deepseek-ai/dsh-tool-image-generation' },
      sourceUrl: 'https://github.com/ankye/dsh-image-generation'
    })
    expect(groups[0]?.packages.map((entry) => entry.name)).toEqual([
      '@deepseek-ai/dsh-tool-image-generation',
      '@deepseek-ai/dsh-client-ui-image-generation'
    ])
    expect(versionView.extensionUpdateMode(groups[0]!)).toBe('adopt')
  })

  it('only marks a complete extension as managed when every package has a managed Git record', () => {
    const [group] = installedExtensionGroupsOf([
      plugin('@deepseek-ai/dsh-tool-vision', {
        sourceUrl: 'https://github.com/ankye/dsh-client-vision',
        managedGitSource: { revision: 'a'.repeat(40), branch: 'main', updateAvailable: true }
      }),
      plugin('@deepseek-ai/dsh-client-ui-vision', {
        sourceUrl: 'https://github.com/ankye/dsh-client-vision',
        managedGitSource: { revision: 'a'.repeat(40), branch: 'main', updateAvailable: false }
      })
    ])

    expect(group).toBeDefined()
    expect(versionView.extensionUpdateMode(group!)).toBe('managed')
    expect(versionView.hasExtensionUpdate(group!)).toBe(true)
  })

  it('identifies client UI packages as settings companions rather than runtime tools', () => {
    expect(isSettingsUiPackage(plugin('@deepseek-ai/dsh-client-ui-vision'))).toBe(true)
    expect(isSettingsUiPackage(plugin('@deepseek-ai/dsh-tool-vision'))).toBe(false)
  })
})
