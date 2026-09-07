import { describe, expect, it, vi } from 'vitest'
import {
  P2P_MANAGEMENT_CHANNELS as channels,
  type P2PManagementApi
} from '../src/shared/p2p-management'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), exposed: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcRenderer: { invoke: mocks.invoke },
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => mocks.exposed.set(name, api) }
}))

describe('formal P2P preload capability surface', () => {
  it('exposes exactly the frozen named methods from the production preload', async () => {
    await import('./preload')
    const desktop = mocks.exposed.get('dshLauncher') as { p2pManagement: P2PManagementApi }
    expect(Object.isFrozen(desktop)).toBe(true)
    expect(Object.isFrozen(desktop.p2pManagement)).toBe(true)
    expect(Object.keys(desktop.p2pManagement).sort()).toEqual(Object.keys(channels).sort())
    const response = { ok: false, code: 'p2p.invalid_request', message: 'p2p.invalid_request' }
    mocks.invoke.mockResolvedValue(response)
    for (const name of Object.keys(channels) as (keyof typeof channels)[]) {
      // The malformed test payload must be forwarded unchanged to main admission.
      const payload = { version: 2, requestId: 3, unexpected: 'reject in main' }
      const method = desktop.p2pManagement[name] as (value: unknown) => Promise<unknown>
      expect(await method(payload)).toBe(response)
      expect(mocks.invoke).toHaveBeenLastCalledWith(channels[name], payload)
    }
    expect(desktop.p2pManagement).not.toHaveProperty('invoke')
    expect(desktop.p2pManagement).not.toHaveProperty('rpc')
    expect(mocks.exposed.size).toBe(1)
  })
})
