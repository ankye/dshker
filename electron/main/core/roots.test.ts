import { describe, expect, it } from 'vitest'
import {
  MANAGED_ROOT_REGISTRY_FORMAT,
  MANAGED_ROOT_REGISTRY_VERSION,
  type ManagedRootRegistry
} from '../managed/model'
import { PeerHelperError } from '../p2p/wire'
import { CoreRoots, type CoreRootsLocation } from './roots'

const location: CoreRootsLocation = {
  filePath: '/managed/settings/dsh-launcher/managed-root-registry.json',
  nativeDshHome: '/native/.dsh',
  pathStyle: 'posix'
}

function registry(): ManagedRootRegistry {
  return {
    format: MANAGED_ROOT_REGISTRY_FORMAT,
    version: MANAGED_ROOT_REGISTRY_VERSION,
    roots: [
      { rootId: 'root_harness', kind: 'harness', canonicalPath: '/managed/harness' },
      { rootId: 'root_plugins', kind: 'plugins', canonicalPath: '/managed/plugins' },
      { rootId: 'root_config', kind: 'presets', canonicalPath: '/managed/config' },
      { rootId: 'root_settings', kind: 'settings', canonicalPath: '/managed/settings' }
    ],
    workspaces: []
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

describe('core roots client', () => {
  it('reads the registry the core owns and sends only the two paths', async () => {
    const rpc = fakeRpc(() => ({ registry: registry() }))
    await expect(new CoreRoots(rpc).inspect(location)).resolves.toEqual(registry())
    expect(rpc.calls).toEqual([
      {
        method: 'core.roots_inspect',
        payload: { filePath: location.filePath, nativeDshHome: location.nativeDshHome }
      }
    ])
  })

  it('commits the whole document and returns what the core published', async () => {
    const rpc = fakeRpc(() => ({ registry: registry() }))
    await expect(new CoreRoots(rpc).commit(location, registry())).resolves.toEqual(registry())
    expect(rpc.calls).toEqual([
      {
        method: 'core.roots_commit',
        payload: {
          filePath: location.filePath,
          nativeDshHome: location.nativeDshHome,
          registry: registry()
        }
      }
    ])
  })

  it('refuses an answer that is not a registry envelope', async () => {
    await expect(new CoreRoots(fakeRpc(() => ({}))).inspect(location)).rejects.toMatchObject({
      code: 'p2p.invalid_payload'
    })
    await expect(new CoreRoots(fakeRpc(() => null)).inspect(location)).rejects.toMatchObject({
      code: 'p2p.invalid_payload'
    })
  })

  it('validates the answer with the rules the shell used while it owned the file', async () => {
    const valid = registry()
    const nested: ManagedRootRegistry = {
      ...valid,
      roots: valid.roots.map((root, index) =>
        index === 1 ? { ...root, canonicalPath: '/managed/harness/plugins' } : root
      )
    }
    await expect(
      new CoreRoots(fakeRpc(() => ({ registry: nested }))).inspect(location)
    ).rejects.toMatchObject({ code: 'managed.root_overlap' })
  })

  it('carries the core refusal through unchanged', async () => {
    const rpc = fakeRpc(() => {
      throw new PeerHelperError('managed.missing_registry')
    })
    await expect(new CoreRoots(rpc).inspect(location)).rejects.toMatchObject({
      code: 'managed.missing_registry'
    })
  })
})
