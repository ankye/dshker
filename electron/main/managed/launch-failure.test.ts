import { describe, expect, it } from 'vitest'
import { launchFailureEventText } from './launch-failure'

describe('launch failure log text', () => {
  /**
   * The log carried the code and nothing else, which left the operator to work
   * out both the cause and the fix from a name like runtime.port_in_use. The
   * codes whose remedy is not obvious now carry it.
   */
  it('names the remedy for a port that is already held', () => {
    const text = launchFailureEventText('runtime.port_in_use')
    expect(text).toContain('runtime.port_in_use')
    expect(text).toContain('left over from an earlier run')
    expect(text).toContain('Settings')
  })

  it('names the remedy for a child that died during startup', () => {
    expect(launchFailureEventText('runtime.child_crashed')).toContain('exited during startup')
  })

  it('leaves a code alone when it needs no explanation', () => {
    expect(launchFailureEventText('p2p.helper_unavailable')).toBe('p2p.helper_unavailable')
  })
})
