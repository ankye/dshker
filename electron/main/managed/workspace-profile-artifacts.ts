import { open, unlink } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedRootError } from './errors'
import type { ManagedWorkspaceDirectories } from './workspace-directories'

// The Launcher starts the ordinary `dsh web` command, and DeepSeek Harness ships
// `packages/bundle/web-app` with no desktop-app bundle, so the generated profile
// names the bundles that actually exist.
const WEB_PROFILE_MANIFEST = {
  name: 'dsh-web-profile',
  private: true,
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      patchReload: 'startup'
    }
  }
} as const

const PLUGIN_GENERATION_MANIFEST = {
  name: 'dsh-web-plugin-generation',
  private: true,
  type: 'module'
} as const

/** Launcher-generated profile files required before a workspace can prepare plugins or launch. */
export interface DesktopWorkspaceProfileArtifacts {
  /** Removes only artifacts created before the workspace binding became durable. */
  remove(): Promise<void>
}

/** Creates the exact initial profile and plugin-generation manifests in fresh workspace directories. */
export async function createDesktopWorkspaceProfileArtifacts(
  directories: ManagedWorkspaceDirectories
): Promise<DesktopWorkspaceProfileArtifacts> {
  const created: string[] = []
  try {
    await writeNewFile(
      nodePath.join(directories.roots.settings, 'package.json'),
      `${JSON.stringify(WEB_PROFILE_MANIFEST, null, 2)}\n`,
      created
    )
    await writeNewFile(
      nodePath.join(directories.roots.settings, 'cordis.patch.yml'),
      '[]\n',
      created
    )
    await writeNewFile(
      nodePath.join(directories.roots.plugins, 'package.json'),
      `${JSON.stringify(PLUGIN_GENERATION_MANIFEST, null, 2)}\n`,
      created
    )
  } catch (error) {
    await removeCreatedArtifacts(created)
    throw error
  }
  return Object.freeze({
    remove: async () => removeCreatedArtifacts(created)
  })
}

async function writeNewFile(path: string, contents: string, created: string[]): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    created.push(path)
  } catch (error) {
    throw new ManagedRootError(
      'managed.persistence_failed',
      'Desktop workspace profile artifact could not be created.',
      { cause: error instanceof Error ? error.name : 'unknown' }
    )
  }
}

async function removeCreatedArtifacts(created: readonly string[]): Promise<void> {
  for (const path of [...created].reverse()) {
    try {
      await unlink(path)
    } catch (error) {
      throw new ManagedRootError(
        'managed.persistence_failed',
        'A partially created desktop workspace profile artifact could not be removed.',
        { cause: error instanceof Error ? error.name : 'unknown' }
      )
    }
  }
}
