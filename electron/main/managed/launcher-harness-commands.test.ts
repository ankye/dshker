// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pnpmCommandEnvironment } from './launcher-harness-commands'

afterEach(() => vi.unstubAllEnvs())

describe('the pnpm command environment', () => {
  it('removes Electron Node mode inherited from the desktop', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const env = pnpmCommandEnvironment(undefined)
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('applies the launcher command search path when one is supplied', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const env = pnpmCommandEnvironment({
      executable: 'irrelevant',
      prefixArguments: [],
      commandSearchPath: '/runtime/bin:/usr/bin'
    })
    expect(env.PATH).toBe('/runtime/bin:/usr/bin')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('removes Electron Node mode from an external pnpm command', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const env = pnpmCommandEnvironment({
      executable: '/usr/local/bin/pnpm',
      prefixArguments: [],
      commandSearchPath: '/usr/local/bin:/usr/bin'
    })
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
