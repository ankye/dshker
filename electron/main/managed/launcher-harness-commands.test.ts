// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pnpmCommandEnvironment } from './launcher-harness-commands'

describe('the pnpm command environment', () => {
  it('carries the Launcher Electron identity for the bundled node launchers', () => {
    const env = pnpmCommandEnvironment(undefined)
    expect(env.DSHKER_NODE_EXECUTABLE).toBe(process.execPath)
  })

  it('applies the launcher command search path when one is supplied', () => {
    const env = pnpmCommandEnvironment({
      executable: 'irrelevant',
      prefixArguments: [],
      commandSearchPath: '/runtime/bin:/usr/bin'
    })
    expect(env.PATH).toBe('/runtime/bin:/usr/bin')
    expect(env.DSHKER_NODE_EXECUTABLE).toBe(process.execPath)
  })
})
