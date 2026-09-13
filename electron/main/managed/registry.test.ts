import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CoreRootsLocation, CoreRootsPort } from '../core/roots'
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

const location = {
  filePath: '/managed/settings/dsh-launcher/managed-root-registry.json',
  nativeDshHomePath: '/native/.dsh',
  pathStyle: 'posix' as const
}

/** What the store hands the core: the same place, named the core's way. */
const expected: CoreRootsLocation = {
  filePath: location.filePath,
  nativeDshHome: location.nativeDshHomePath,
  pathStyle: location.pathStyle
}

describe('managed root registry', () => {
  it('routes every read and write to the core, which owns the file', async () => {
    const registry = registryAt('/managed')
    const calls: string[] = []
    const port: CoreRootsPort = {
      async inspect(received) {
        calls.push(`inspect ${received.filePath}`)
        expect(received).toEqual(expected)
        return registry
      },
      async commit(received, value) {
        calls.push(`commit ${received.filePath}`)
        expect(value).toEqual(registry)
        return value
      }
    }
    const store = new ManagedRootRegistryStore(location, port)

    await expect(store.load()).resolves.toEqual(registry)
    await expect(store.save(registry)).resolves.toBeUndefined()
    expect(calls).toEqual([`inspect ${expected.filePath}`, `commit ${expected.filePath}`])
  })

  it('refuses to read or write without a core instead of falling back to a second writer', async () => {
    const store = new ManagedRootRegistryStore(location)
    await expect(store.load()).rejects.toMatchObject({ code: 'managed.core_unavailable' })
    await expect(store.save(registryAt('/managed'))).rejects.toMatchObject({
      code: 'managed.core_unavailable'
    })
  })

  it('reports a core that answered with a different document rather than claiming success', async () => {
    const registry = registryAt('/managed')
    const store = new ManagedRootRegistryStore(location, {
      async inspect() {
        return registry
      },
      async commit() {
        return { ...registry, roots: registry.roots.slice(0, 3) }
      }
    })
    await expect(store.save(registry)).rejects.toMatchObject({ code: 'managed.persistence_failed' })
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
