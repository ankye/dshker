import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerManagement } from './management'

/**
 * The local device id is this machine's own identifier, and it has to be the one
 * every other side uses: the coordinator registers it, the network member list
 * shows it and a peer pins it.
 *
 * It is therefore the machine key's id — twelve hex characters, derived from the
 * public key exactly as the coordinator derives it — and not a number minted in
 * the settings root for display. A locally invented id looked like an identifier
 * but named a device no server or peer had ever heard of, so the id on screen
 * could not be found in any member list and could not be compared with anything.
 */
describe('local device identity', () => {
  const owners: PeerManagement[] = []
  /** A stand-in for the core's machine device key: seed and public half. */
  const key = Buffer.concat([Buffer.alloc(32, 7), Buffer.alloc(32, 9)])
  const publicKey = key.subarray(32)
  const expectedId = createHash('sha256').update(publicKey).digest('hex').slice(0, 12)

  afterEach(() => {
    for (const owner of owners.splice(0)) void owner.close()
  })

  function owner(): PeerManagement {
    // The catalog must exist before the core is reachable, so an enabled catalog
    // is part of the fixture rather than an accident of the settings root.
    const catalog = { inspect: async () => ({ revision: 'a'.repeat(64), record: record() }) }
    const management = new PeerManagement({
      channel: {
        call: vi.fn(async (method: string) => {
          if (method === 'device.createKey')
            return { privateKey: key.toString('base64'), csr: 'test-only-csr' }
          return {}
        }),
        serve: () => () => undefined,
        observe: () => () => undefined
      } as never,
      resolveSettingsRoot: async () => '/test-owned-settings',
      catalog: catalog as never,
      secrets: undefined,
      runtime: {
        getRuntimeState: () => ({ kind: 'stopped' }),
        onRuntimeState: () => () => undefined,
        start: vi.fn(async () => undefined)
      }
    } as never)
    owners.push(management)
    return management
  }

  function record() {
    return {
      revision: 'a'.repeat(64),
      catalogId: 'b'.repeat(12),
      services: [],
      computers: [],
      forgottenServiceIds: []
    }
  }

  it('reports the machine key id, not a locally minted number', async () => {
    const device = await owner().localDevice(new AbortController().signal)

    expect(device.deviceId).toBe(expectedId)
    expect(device.deviceId).toMatch(/^[0-9a-f]{12}$/)
  })

  it('keeps one id across reads', async () => {
    const first = await owner().localDevice(new AbortController().signal)
    const second = await owner().localDevice(new AbortController().signal)

    // The id belongs to the key, so a second read of an unmoved key cannot differ.
    expect(second.deviceId).toBe(first.deviceId)
  })
})
