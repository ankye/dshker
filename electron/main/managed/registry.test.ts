import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedRootError } from './errors'
import {
  MANAGED_ROOT_REGISTRY_FORMAT,
  MANAGED_ROOT_REGISTRY_VERSION,
  type ManagedRootRegistry
} from './model'
import { ManagedRootRegistryStore, parseManagedRootRegistry } from './registry'
import { assertManagedRootLayout, assertWorkspaceNamespace } from './validation'

function registryAt(base: string): ManagedRootRegistry {
  return {
    format: MANAGED_ROOT_REGISTRY_FORMAT,
    version: MANAGED_ROOT_REGISTRY_VERSION,
    roots: [
      { rootId: 'root_harness', kind: 'harness', canonicalPath: nodePath.join(base, 'harness') },
      { rootId: 'root_plugins', kind: 'plugins', canonicalPath: nodePath.join(base, 'plugins') },
      {
        rootId: 'root_config',
        kind: 'presets',
        canonicalPath: nodePath.join(base, 'config')
      },
      { rootId: 'root_settings', kind: 'settings', canonicalPath: nodePath.join(base, 'settings') }
    ],
    workspaces: [
      {
        workspaceId: 'workspace_main',
        displayName: 'Main workspace',
        workingDirectoryCapabilityId: 'cap_workspace_main',
        workingDirectoryCanonicalPath: nodePath.join(base, 'working-directory'),
        rootNamespaces: [
          { rootId: 'root_harness', namespace: 'workspaces/main' },
          { rootId: 'root_plugins', namespace: 'workspaces/main' },
          { rootId: 'root_config', namespace: 'workspaces/main' },
          { rootId: 'root_settings', namespace: 'workspaces/main' }
        ]
      }
    ]
  }
}

describe('managed root registry', () => {
  it('writes a complete registry atomically and reads back the exact record', async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-roots-'))
    const settings = nodePath.join(base, 'settings')
    await mkdir(settings)
    const registry = registryAt(base)
    const store = new ManagedRootRegistryStore({
      filePath: nodePath.join(settings, 'registry.json'),
      pathStyle: 'posix',
      nativeDshHomePath: nodePath.join(base, 'native-dsh-home')
    })

    await store.save(registry)

    await expect(store.load()).resolves.toEqual(registry)
    await expect(readFile(nodePath.join(settings, 'registry.json'), 'utf8')).resolves.toContain(
      MANAGED_ROOT_REGISTRY_FORMAT
    )
  })

  it('rejects an unknown persisted field instead of discarding it', () => {
    const registry = registryAt('/managed') as unknown as Record<string, unknown>
    registry.unexpected = true

    expect(() =>
      parseManagedRootRegistry(JSON.stringify(registry), 'posix', '/native/.dsh')
    ).toThrow(ManagedRootError)
  })

  it('rejects nested roots and portable namespace traversal', () => {
    expect(() =>
      assertManagedRootLayout(
        [
          { rootId: 'root_harness', kind: 'harness', canonicalPath: '/managed/harness' },
          { rootId: 'root_plugins', kind: 'plugins', canonicalPath: '/managed/harness/plugins' },
          { rootId: 'root_config', kind: 'presets', canonicalPath: '/managed/presets' },
          { rootId: 'root_settings', kind: 'settings', canonicalPath: '/managed/settings' }
        ],
        'posix',
        '/native/.dsh'
      )
    ).toThrow('must not overlap')
    expect(() => assertWorkspaceNamespace('../escape')).toThrow('escapes its root')
    expect(() => assertWorkspaceNamespace('workspaces\\main')).toThrow('not portable')
  })

  it('rejects a Launcher path inside a Harness-owned .dsh runtime directory', () => {
    expect(() =>
      assertManagedRootLayout(
        [
          { rootId: 'root_harness', kind: 'harness', canonicalPath: '/managed/harness' },
          { rootId: 'root_plugins', kind: 'plugins', canonicalPath: '/managed/plugins' },
          {
            rootId: 'root_config',
            kind: 'presets',
            canonicalPath: '/managed/.dsh/presets'
          },
          { rootId: 'root_settings', kind: 'settings', canonicalPath: '/managed/settings' }
        ],
        'posix',
        '/native/.dsh'
      )
    ).toThrow('outside Harness `.dsh` runtime directories')
  })

  it('rejects a Launcher root that is an ancestor of the existing Harness home', () => {
    expect(() =>
      assertManagedRootLayout(
        [
          { rootId: 'root_harness', kind: 'harness', canonicalPath: '/managed/harness' },
          { rootId: 'root_plugins', kind: 'plugins', canonicalPath: '/managed/plugins' },
          { rootId: 'root_config', kind: 'presets', canonicalPath: '/managed/presets' },
          { rootId: 'root_settings', kind: 'settings', canonicalPath: '/native' }
        ],
        'posix',
        '/native/.dsh'
      )
    ).toThrow('disjoint from the existing Harness runtime directory')
  })
})
