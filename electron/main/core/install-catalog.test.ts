import { describe, expect, it } from 'vitest'
import { createEmptyManagedInstallationCatalog } from '../managed/installation-catalog'
import type { ManagedInstallationCatalog } from '../managed/installation-catalog'
import { PeerHelperError } from '../p2p/wire'
import { CoreInstallCatalog, type CoreInstallCatalogLocation } from './install-catalog'

const location: CoreInstallCatalogLocation = {
  filePath: '/managed/settings/dsh-launcher/managed-installation-catalog.json'
}

/** The paths are validated with the platform's own API, so the fixture matches the host. */
const executable = (name: string): string =>
  process.platform === 'win32' ? `C:\\managed\\${name}.exe` : `/managed/${name}`

function catalog(): ManagedInstallationCatalog {
  return {
    ...createEmptyManagedInstallationCatalog(),
    toolchains: [
      {
        toolchainId: 'toolchain_main',
        git: {
          requestedPath: executable('git'),
          canonicalPath: executable('git'),
          fingerprint: { device: 1, inode: 2, size: 3, modifiedAtMilliseconds: 4 },
          version: { major: 2, minor: 43, patch: 0, text: '2.43.0' }
        },
        node: {
          requestedPath: executable('node'),
          canonicalPath: executable('node'),
          fingerprint: {
            device: 5,
            inode: 6,
            mode: 33261,
            size: 7,
            modifiedAtMilliseconds: 8,
            changedAtMilliseconds: 9
          },
          version: { major: 22, minor: 19, patch: 0, text: '22.19.0' }
        },
        pnpm: {
          requestedPath: executable('pnpm'),
          canonicalPath: executable('pnpm'),
          fingerprint: {
            device: 10,
            inode: 11,
            mode: 33261,
            size: 12,
            modifiedAtMilliseconds: 13,
            changedAtMilliseconds: 14
          },
          launcher: { kind: 'native' },
          version: { major: 11, minor: 7, patch: 0, text: '11.7.0' }
        }
      }
    ],
    installations: []
  }
}

function fakeRpc(answer: (method: string, payload: unknown) => unknown) {
  const calls: { method: string; payload: unknown }[] = []
  return {
    calls,
    call: (method: string, payload: unknown): Promise<unknown> => {
      calls.push({ method, payload })
      return Promise.resolve(answer(method, payload))
    }
  }
}

describe('core install catalog client', () => {
  it('reads the catalog the core owns and sends only its path', async () => {
    const rpc = fakeRpc(() => ({ catalog: catalog() }))
    await expect(new CoreInstallCatalog(rpc).inspect(location)).resolves.toEqual(catalog())
    expect(rpc.calls).toEqual([
      { method: 'core.install_catalog_inspect', payload: { filePath: location.filePath } }
    ])
  })

  it('commits the whole catalog and returns what the core published', async () => {
    const rpc = fakeRpc(() => ({ catalog: catalog() }))
    await expect(new CoreInstallCatalog(rpc).commit(location, catalog())).resolves.toEqual(
      catalog()
    )
    expect(rpc.calls).toEqual([
      {
        method: 'core.install_catalog_commit',
        payload: { filePath: location.filePath, catalog: catalog() }
      }
    ])
  })

  it('refuses an answer that is not a catalog envelope', async () => {
    await expect(
      new CoreInstallCatalog(fakeRpc(() => ({}))).inspect(location)
    ).rejects.toMatchObject({
      code: 'p2p.invalid_payload'
    })
    await expect(
      new CoreInstallCatalog(fakeRpc(() => null)).inspect(location)
    ).rejects.toMatchObject({ code: 'p2p.invalid_payload' })
  })

  it('validates the answer with the rules the shell used while it owned the file', async () => {
    const valid = catalog()
    const duplicated: ManagedInstallationCatalog = {
      ...valid,
      toolchains: [...valid.toolchains, ...valid.toolchains]
    }
    await expect(
      new CoreInstallCatalog(fakeRpc(() => ({ catalog: duplicated }))).inspect(location)
    ).rejects.toMatchObject({ code: 'managed.invalid_record' })

    const relative: ManagedInstallationCatalog = {
      ...valid,
      toolchains: valid.toolchains.map((toolchain) => ({
        ...toolchain,
        node: { ...toolchain.node, canonicalPath: 'node' }
      }))
    }
    await expect(
      new CoreInstallCatalog(fakeRpc(() => ({ catalog: relative }))).inspect(location)
    ).rejects.toMatchObject({ code: 'managed.invalid_record' })
  })

  it('carries the core refusal through unchanged', async () => {
    const rpc = fakeRpc(() => {
      throw new PeerHelperError('managed.missing_registry')
    })
    await expect(new CoreInstallCatalog(rpc).inspect(location)).rejects.toMatchObject({
      code: 'managed.missing_registry'
    })
  })
})
