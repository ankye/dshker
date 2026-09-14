import nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CoreInstallCatalogLocation, CoreInstallCatalogPort } from '../core/install-catalog'
import { ManagedRootError } from './errors'
import {
  createEmptyManagedInstallationCatalog,
  ManagedInstallationCatalogStore,
  managedInstallationCatalogFilePath,
  parseManagedInstallationCatalog,
  type ManagedInstallationCatalog
} from './installation-catalog'
import { createGitNamedRemote, parseGitCommitSha, selectGitTag } from './git'

function tagInstallationCatalog(): ManagedInstallationCatalog {
  const commit = parseGitCommitSha('a'.repeat(40))
  // Persisted toolchain paths are validated by the platform's own path API, so
  // the fixture derives its absolute directory from this process at runtime.
  const registeredDirectory =
    process.platform === 'win32'
      ? nodePath.win32.join(nodePath.parse(process.cwd()).root, 'registered')
      : '/usr/local/bin'
  const registered = (name: string): string => nodePath.join(registeredDirectory, name)
  return {
    ...createEmptyManagedInstallationCatalog(),
    toolchains: [
      {
        toolchainId: 'toolchain_main',
        git: {
          requestedPath: registered('git'),
          canonicalPath: registered('git'),
          fingerprint: {
            device: 1,
            inode: 2,
            size: 3,
            modifiedAtMilliseconds: 4
          },
          version: {
            major: 2,
            minor: 42,
            patch: 0,
            text: '2.42.0'
          }
        },
        node: {
          requestedPath: registered('node'),
          canonicalPath: registered('node'),
          fingerprint: {
            device: 5,
            inode: 6,
            mode: 33261,
            size: 7,
            modifiedAtMilliseconds: 8,
            changedAtMilliseconds: 9
          },
          version: {
            major: 22,
            minor: 19,
            patch: 0,
            text: '22.19.0'
          }
        },
        pnpm: {
          requestedPath: registered('pnpm'),
          canonicalPath: registered('pnpm'),
          fingerprint: {
            device: 10,
            inode: 11,
            mode: 33261,
            size: 12,
            modifiedAtMilliseconds: 13,
            changedAtMilliseconds: 14
          },
          launcher: { kind: 'native' },
          version: {
            major: 11,
            minor: 7,
            patch: 0,
            text: '11.7.0'
          }
        }
      }
    ],
    installations: [
      {
        installationId: 'installation_main',
        workspaceId: 'workspace_main',
        toolchainId: 'toolchain_main',
        remote: createGitNamedRemote('origin', 'https://github.com/ankye/dshker.git'),
        selection: selectGitTag('v1.0.0'),
        commit,
        observedReference: 'refs/tags/v1.0.0',
        observedObject: 'b'.repeat(40),
        tagObject: 'b'.repeat(40)
      }
    ]
  }
}

const location: CoreInstallCatalogLocation = {
  filePath: managedInstallationCatalogFilePath('/managed/settings', 'posix')
}

describe('managed installation catalog', () => {
  it('routes every read and write to the core, which owns the file', async () => {
    const catalog = tagInstallationCatalog()
    const calls: string[] = []
    const port: CoreInstallCatalogPort = {
      async inspect(received) {
        calls.push(`inspect ${received.filePath}`)
        return catalog
      },
      async commit(received, value) {
        calls.push(`commit ${received.filePath}`)
        expect(value).toEqual(catalog)
        return value
      }
    }
    const store = new ManagedInstallationCatalogStore(location, port)

    await expect(store.load()).resolves.toEqual(catalog)
    await expect(store.save(catalog)).resolves.toBeUndefined()
    expect(calls).toEqual([`inspect ${location.filePath}`, `commit ${location.filePath}`])
  })

  it('refuses to read or write without a core instead of falling back to a second writer', async () => {
    const store = new ManagedInstallationCatalogStore(location)
    await expect(store.load()).rejects.toMatchObject({ code: 'managed.core_unavailable' })
    await expect(store.save(tagInstallationCatalog())).rejects.toMatchObject({
      code: 'managed.core_unavailable'
    })
  })

  it('reports a core that answered with a different catalog rather than claiming success', async () => {
    const catalog = tagInstallationCatalog()
    const store = new ManagedInstallationCatalogStore(location, {
      async inspect() {
        return catalog
      },
      async commit() {
        return { ...catalog, installations: [] }
      }
    })
    await expect(store.save(catalog)).rejects.toMatchObject({ code: 'managed.persistence_failed' })
  })

  it('rejects legacy fields on a discriminated revision record', () => {
    const parsed = JSON.parse(JSON.stringify(tagInstallationCatalog())) as {
      installations: Array<{ selection: Record<string, unknown> }>
    }
    parsed.installations[0].selection.branch = 'main'

    expect(() => parseManagedInstallationCatalog(JSON.stringify(parsed))).toThrow(ManagedRootError)
  })

  it('rejects a tag record without its observed tag object', () => {
    const parsed = JSON.parse(JSON.stringify(tagInstallationCatalog())) as {
      installations: Array<Record<string, unknown>>
    }
    delete parsed.installations[0].tagObject

    expect(() => parseManagedInstallationCatalog(JSON.stringify(parsed))).toThrow(ManagedRootError)
  })
})
