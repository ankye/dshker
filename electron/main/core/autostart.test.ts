import { describe, expect, it, vi } from 'vitest'
import { CoreAutostart } from './autostart'

describe('profile autostart boundary', () => {
  it('refuses every isolated operation before sending a core RPC', async () => {
    const rpc = { call: vi.fn() }
    const client = new CoreAutostart(rpc, true)
    for (const operation of ['status', 'enable', 'disable'] as const) {
      await expect(client[operation]()).rejects.toMatchObject({
        code: 'p2p.autostart_unsupported'
      })
    }
    expect(rpc.call).not.toHaveBeenCalled()
  })

  it('keeps stable status, enable and disable on the existing core authority', async () => {
    const state = { installed: true, supported: true, mechanism: 'launchd', path: '/job' }
    const rpc = { call: vi.fn(async () => state) }
    const client = new CoreAutostart(rpc)
    const signal = new AbortController().signal
    for (const operation of ['status', 'enable', 'disable'] as const) {
      expect(await client[operation](signal)).toEqual(state)
      expect(rpc.call).toHaveBeenLastCalledWith(`core.autostart_${operation}`, {}, signal)
    }
  })
})
