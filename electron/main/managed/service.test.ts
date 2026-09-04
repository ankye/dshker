import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedBootstrapLocatorStore } from './bootstrap-locator'
import {
  DirectorySelectionCapabilities,
  type DirectoryPicker,
  type DirectorySelectionPurpose
} from './capabilities'
import { ManagedRootError } from './errors'
import { ManagedWorkspaceService } from './service'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

class FixtureDirectoryPicker implements DirectoryPicker {
  readonly #paths: Map<DirectorySelectionPurpose, string>

  constructor(paths: Map<DirectorySelectionPurpose, string>) {
    this.#paths = paths
  }

  async pickDirectory(purpose: DirectorySelectionPurpose): Promise<string | undefined> {
    return this.#paths.get(purpose)
  }

  set(purpose: DirectorySelectionPurpose, directory: string): void {
    this.#paths.set(purpose, directory)
  }
}

async function fixture(): Promise<{
  readonly service: ManagedWorkspaceService
  readonly base: string
  readonly roots: ReadonlyMap<DirectorySelectionPurpose, string>
  readonly workingDirectory: string
  readonly picker: FixtureDirectoryPicker
}> {
  const base = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-managed-'))
  temporaryDirectories.push(base)
  const rootKinds = ['harness', 'plugins', 'presets', 'settings'] as const
  const rootEntries = await Promise.all(
    rootKinds.map(async (kind) => {
      const directory = nodePath.join(base, kind)
      await mkdir(directory)
      return [`managed-root:${kind}` as const, directory] as const
    })
  )
  const workingDirectory = nodePath.join(base, 'project')
  await mkdir(workingDirectory)
  const roots = new Map<DirectorySelectionPurpose, string>(rootEntries)
  const picker = new FixtureDirectoryPicker(
    new Map([...rootEntries, ['workspace-working-directory', workingDirectory]])
  )
  // Native temp paths must be validated by the matching platform spelling.
  const pathStyle = process.platform === 'win32' ? ('win32' as const) : ('posix' as const)
  const service = new ManagedWorkspaceService({
    locator: new ManagedBootstrapLocatorStore({
      filePath: nodePath.join(base, 'platform-state', 'bootstrap.json'),
      pathStyle,
      nativeDshHomePath: nodePath.join(base, 'native-dsh-home')
    }),
    capabilities: new DirectorySelectionCapabilities({ ttlMilliseconds: 30_000, now: () => 1_000 }),
    directoryPicker: picker,
    pathStyle,
    nativeDshHomePath: nodePath.join(base, 'native-dsh-home'),
    defaultRootPaths: {
      harness: nodePath.join(base, 'default-harness'),
      plugins: nodePath.join(base, 'default-plugins'),
      presets: nodePath.join(base, 'default-presets'),
      settings: nodePath.join(base, 'default-settings')
    }
  })
  return { service, base, roots, workingDirectory, picker }
}

async function selectAllRoots(service: ManagedWorkspaceService) {
  const kinds = ['harness', 'plugins', 'presets', 'settings'] as const
  return Promise.all(
    kinds.map(async (kind) => {
      const selection = await service.selectDirectory(`managed-root:${kind}`)
      return { kind, capabilityId: selection.capabilityId }
    })
  )
}

describe('managed workspace service', () => {
  it('requires explicit setup, commits four selected roots, and binds a separate working directory', async () => {
    const { service, base, workingDirectory } = await fixture()
    await expect(service.getState()).resolves.toEqual({
      kind: 'setup-required',
      code: 'managed.missing_bootstrap_locator'
    })

    const roots = await selectAllRoots(service)
    const registered = await service.registerRoots({ selections: roots })
    expect(registered.kind).toBe('ready')
    if (registered.kind !== 'ready') throw new Error('Expected ready state.')
    expect(registered.roots.map((root) => root.kind)).toEqual([
      'harness',
      'plugins',
      'presets',
      'settings'
    ])
    await expect(
      readFile(
        nodePath.join(base, 'settings', 'dsh-launcher', 'managed-root-registry.json'),
        'utf8'
      )
    ).resolves.toContain('dsh-launcher.managed-root-registry')
    await expect(
      readFile(
        nodePath.join(base, 'settings', 'dsh-launcher', 'managed-installation-catalog.json'),
        'utf8'
      )
    ).resolves.toContain('dsh-launcher.managed-installation-catalog')

    const workingDirectorySelection = await service.selectDirectory('workspace-working-directory')
    const workspaceState = await service.createWorkspace({
      displayName: 'Primary workspace',
      workingDirectoryCapabilityId: workingDirectorySelection.capabilityId
    })
    expect(workspaceState.kind).toBe('ready')
    if (workspaceState.kind !== 'ready') throw new Error('Expected ready state.')
    expect(workspaceState.workspaces).toEqual([
      expect.objectContaining({
        displayName: 'Primary workspace',
        workingDirectoryCanonicalPath: await realpath(workingDirectory)
      })
    ])
    const workspace = workspaceState.workspaces[0]
    if (!workspace) throw new Error('Expected created workspace.')
    const canonicalBase = await realpath(base)
    const directories = await service.getWorkspaceDirectories(workspace.workspaceId)
    expect(directories).toMatchObject({
      workspace: { workspaceId: workspace.workspaceId },
      directories: {
        roots: {
          harness: nodePath.join(canonicalBase, 'harness', 'workspaces', workspace.workspaceId),
          plugins: nodePath.join(canonicalBase, 'plugins', 'workspaces', workspace.workspaceId),
          presets: nodePath.join(canonicalBase, 'presets', 'workspaces', workspace.workspaceId),
          settings: nodePath.join(canonicalBase, 'settings', 'workspaces', workspace.workspaceId)
        }
      }
    })
    await expect(
      readFile(nodePath.join(directories.directories.roots.settings, 'cordis.patch.yml'), 'utf8')
    ).resolves.toBe('[]\n')
    await expect(
      readFile(nodePath.join(directories.directories.roots.settings, 'package.json'), 'utf8').then(
        JSON.parse
      )
    ).resolves.toMatchObject({
      name: 'dsh-web-profile',
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          patchReload: 'startup'
        }
      }
    })
    await expect(
      readFile(nodePath.join(directories.directories.roots.plugins, 'package.json'), 'utf8').then(
        JSON.parse
      )
    ).resolves.toMatchObject({ name: 'dsh-web-plugin-generation', private: true })
  })

  it('rejects root overlap before committing the bootstrap locator', async () => {
    const { service, roots, picker } = await fixture()
    const harness = roots.get('managed-root:harness')
    if (!harness) throw new Error('Missing harness fixture root.')
    const nestedPlugins = nodePath.join(harness, 'plugins')
    await mkdir(nestedPlugins)
    picker.set('managed-root:plugins', nestedPlugins)

    const selections = await selectAllRoots(service)
    const pluginsSelection = await service.selectDirectory('managed-root:plugins')
    const replaced = selections.map((selection) =>
      selection.kind === 'plugins'
        ? { kind: selection.kind, capabilityId: pluginsSelection.capabilityId }
        : selection
    )
    await expect(service.registerRoots({ selections: replaced })).rejects.toMatchObject({
      code: 'managed.root_overlap'
    })
    await expect(service.getState()).resolves.toEqual({
      kind: 'setup-required',
      code: 'managed.missing_bootstrap_locator'
    })
  })

  it('rejects a nonempty root before committing the bootstrap locator', async () => {
    const { service, roots } = await fixture()
    const harness = roots.get('managed-root:harness')
    if (!harness) throw new Error('Missing harness fixture root.')
    await writeFile(nodePath.join(harness, 'unmanaged.txt'), 'not launcher state\n')

    await expect(
      service.registerRoots({ selections: await selectAllRoots(service) })
    ).rejects.toMatchObject({
      code: 'managed.root_not_empty'
    })
    await expect(service.getState()).resolves.toEqual({
      kind: 'setup-required',
      code: 'managed.missing_bootstrap_locator'
    })
  })

  it('consumes a one-time native selection instead of retaining path authority', () => {
    const capabilities = new DirectorySelectionCapabilities({ ttlMilliseconds: 1, now: () => 50 })
    const capability = capabilities.issue(
      'workspace-working-directory',
      '/managed/project',
      'project'
    )
    expect(() =>
      capabilities.consume(capability.capabilityId, 'workspace-working-directory')
    ).not.toThrow()
    expect(() =>
      capabilities.inspect(capability.capabilityId, 'workspace-working-directory')
    ).toThrow(ManagedRootError)
  })

  it('resolves the registered Settings root from revalidated persisted state on every call', async () => {
    const { service, base } = await fixture()
    await service.registerRoots({ selections: await selectAllRoots(service) })

    await expect(service.resolveSettingsRoot()).resolves.toBe(
      await realpath(nodePath.join(base, 'settings'))
    )

    await rm(nodePath.join(base, 'settings'), { recursive: true })
    await expect(service.resolveSettingsRoot()).rejects.toMatchObject({
      code: 'managed.root_not_directory'
    })
  })
})
