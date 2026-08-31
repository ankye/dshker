import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagedRootError } from './errors'
import {
  createEmptyManagedInstallationCatalog,
  ManagedInstallationCatalogStore,
  managedInstallationCatalogFilePath,
  parseManagedInstallationCatalog,
  type ManagedInstallationCatalog
} from './installation-catalog'
import { createGitNamedRemote, parseGitCommitSha, selectGitTag } from './git'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

function tagInstallationCatalog(): ManagedInstallationCatalog {
  const commit = parseGitCommitSha('a'.repeat(40))
  return {
    ...createEmptyManagedInstallationCatalog(),
    toolchains: [
      {
        toolchainId: 'toolchain_main',
        git: {
          requestedPath: '/usr/bin/git',
          canonicalPath: '/usr/bin/git',
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
          requestedPath: '/usr/local/bin/node',
          canonicalPath: '/usr/local/bin/node',
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
          requestedPath: '/usr/local/bin/pnpm',
          canonicalPath: '/usr/local/bin/pnpm',
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
        remote: createGitNamedRemote('origin', 'https://github.com/ankye/dsh-launcher.git'),
        selection: selectGitTag('v1.0.0'),
        commit,
        observedReference: 'refs/tags/v1.0.0',
        observedObject: 'b'.repeat(40),
        tagObject: 'b'.repeat(40)
      }
    ]
  }
}

describe('managed installation catalog', () => {
  it('writes and reads a tag record without manufacturing optional union fields', async () => {
    const base = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-catalog-'))
    temporaryDirectories.push(base)
    const settingsRoot = nodePath.join(base, 'settings')
    await mkdir(nodePath.join(settingsRoot, 'dsh-launcher'), { recursive: true })
    const store = new ManagedInstallationCatalogStore({
      filePath: managedInstallationCatalogFilePath(settingsRoot, 'posix'),
      pathStyle: 'posix'
    })
    const catalog = tagInstallationCatalog()

    await store.save(catalog)

    await expect(store.load()).resolves.toEqual(catalog)
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
