import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertProfileCompatibility, satisfiesVersion } from './profile-compatibility'

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(nodePath.dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

describe('satisfiesVersion', () => {
  it('orders prereleases so 0.2.0-rc.1 is outside <0.2.0-0', () => {
    expect(satisfiesVersion('0.2.0-rc.1', '>=0.1.2-alpha.5 <0.2.0-0')).toBe(false)
    expect(satisfiesVersion('0.1.7-rc.1', '>=0.1.2-alpha.5 <0.2.0-0')).toBe(true)
  })

  it('supports alternatives and unconstrained peer ranges', () => {
    expect(satisfiesVersion('0.2.0-rc.1', '*')).toBe(true)
    expect(satisfiesVersion('0.2.0-rc.1', '0.1.0 || >=0.2.0-rc.1')).toBe(true)
  })
})

describe('assertProfileCompatibility', () => {
  it('refuses an installed plugin before the active pointer can launch it', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'dsh-profile-compatibility-'))
    try {
      const versionDirectory = nodePath.join(root, 'version')
      const dshHomeDirectory = nodePath.join(root, 'dsh')
      const pluginDirectory = nodePath.join(root, 'plugin')
      await writeJson(nodePath.join(versionDirectory, 'package.json'), {
        name: '@deepseek-ai/dsh-root',
        version: '0.2.0-rc.1'
      })
      await writeJson(nodePath.join(versionDirectory, 'packages/settings/settings/package.json'), {
        name: '@deepseek-ai/dsh-settings',
        version: '0.2.0-rc.1'
      })
      await writeJson(nodePath.join(pluginDirectory, 'package.json'), {
        name: '@example/old-plugin',
        version: '0.1.0',
        peerDependencies: { '@deepseek-ai/dsh-settings': '>=0.1.2-alpha.5 <0.2.0-0' }
      })
      await writeJson(nodePath.join(dshHomeDirectory, 'profiles/web/package.json'), {
        dependencies: { '@example/old-plugin': `file:${pluginDirectory}` },
        dsh: { profile: { bundles: ['@example/old-plugin'] } }
      })

      await expect(
        assertProfileCompatibility(versionDirectory, dshHomeDirectory)
      ).rejects.toMatchObject({
        code: 'runtime.plugin_incompatible'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a core version inside the plugin peer range', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'dsh-profile-compatibility-'))
    try {
      const versionDirectory = nodePath.join(root, 'version')
      const dshHomeDirectory = nodePath.join(root, 'dsh')
      const pluginDirectory = nodePath.join(root, 'plugin')
      await writeJson(nodePath.join(versionDirectory, 'package.json'), {
        name: '@deepseek-ai/dsh-root',
        version: '0.1.7-rc.1'
      })
      await writeJson(nodePath.join(versionDirectory, 'packages/settings/settings/package.json'), {
        name: '@deepseek-ai/dsh-settings',
        version: '0.1.7-rc.1'
      })
      await writeJson(nodePath.join(pluginDirectory, 'package.json'), {
        name: '@example/old-plugin',
        version: '0.1.0',
        peerDependencies: { '@deepseek-ai/dsh-settings': '>=0.1.2-alpha.5 <0.2.0-0' }
      })
      await writeJson(nodePath.join(dshHomeDirectory, 'profiles/web/package.json'), {
        dependencies: { '@example/old-plugin': `file:${pluginDirectory}` },
        dsh: { profile: { bundles: ['@example/old-plugin'] } }
      })

      await expect(
        assertProfileCompatibility(versionDirectory, dshHomeDirectory)
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
