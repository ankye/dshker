import { describe, expect, it } from 'vitest'
import { assertStateProgress, parseHelperState, type PeerHelperState } from './helper-state'

function state(stage: PeerHelperState['stage'], runtimeGeneration = 8): PeerHelperState {
  return {
    pairId: 'a'.repeat(12),
    attemptId: 'b'.repeat(32),
    generation: 42,
    stage,
    error: stage === 'failed' ? 'p2p.direct_closed' : '',
    path: { localType: 'host', remoteType: 'srflx', protocol: 'udp' },
    runtimeGeneration
  }
}

describe('exact primary suspension admission', () => {
  it('admits a suspended v2 primary without exposing a workbench URL', () => {
    expect(parseHelperState(state('suspended'))).toEqual(state('suspended'))
    expect(JSON.stringify(parseHelperState(state('suspended')))).not.toMatch(/http|token|cookie/i)
  })

  it('continues admitting explicit v1 attempt identity without widening pair ids', () => {
    expect(
      parseHelperState({ ...state('suspended'), attemptId: 'b'.repeat(12) }).attemptId
    ).toHaveLength(12)
    expect(() => parseHelperState({ ...state('suspended'), pairId: 'a'.repeat(32) })).toThrow()
    for (const attemptId of ['b'.repeat(16), 'x'.repeat(32), 'b'.repeat(33)])
      expect(() => parseHelperState({ ...state('suspended'), attemptId })).toThrow()
  })

  it.each([
    { error: 'p2p.direct_closed' },
    { path: { localType: '', remoteType: '', protocol: '' } },
    { path: { localType: 'relay', remoteType: 'host', protocol: 'udp' } },
    { runtimeGeneration: -1 },
    { url: 'http://127.0.0.1:3088/' }
  ])('rejects malformed suspended state %o', (invalid) => {
    expect(() => parseHelperState({ ...state('suspended'), ...invalid })).toThrow()
  })

  it('allows repeated ready/suspended cycles within one exact runtime authority', () => {
    const ready = parseHelperState(state('ready'))
    const suspended = parseHelperState(state('suspended'))
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(() => assertStateProgress(ready, suspended)).not.toThrow()
      expect(() => assertStateProgress(suspended, suspended)).not.toThrow()
      expect(() => assertStateProgress(suspended, ready)).not.toThrow()
    }
  })

  it('allows transport-only suspension to recover only as transport-only', () => {
    const connected = parseHelperState(state('connected', 0))
    const suspended = parseHelperState(state('suspended', 0))
    expect(() => assertStateProgress(connected, suspended)).not.toThrow()
    expect(() => assertStateProgress(suspended, connected)).not.toThrow()
    expect(() => assertStateProgress(suspended, state('ready'))).toThrow()
  })

  it.each(['failed', 'disconnected'] as const)('does not revive a terminal %s', (terminal) => {
    expect(() => assertStateProgress(state(terminal), state('suspended'))).toThrow()
    expect(() => assertStateProgress(state(terminal), state('ready'))).toThrow()
    expect(() => assertStateProgress(state('suspended'), state(terminal))).not.toThrow()
  })

  it('rejects generation and runtime replacement inside one suspended attempt', () => {
    const suspended = state('suspended')
    expect(() => assertStateProgress(suspended, { ...state('ready'), generation: 43 })).toThrow()
    expect(() => assertStateProgress(suspended, state('ready', 9))).toThrow()
    expect(() => assertStateProgress(state('ready'), state('suspended', 9))).toThrow()
    expect(() => assertStateProgress(state('punching', 0), state('suspended', 0))).toThrow()
  })

  it('does not mistake an explicitly new attempt for revival of the old one', () => {
    expect(() =>
      assertStateProgress(state('failed'), { ...state('punching', 0), attemptId: 'c'.repeat(32) })
    ).not.toThrow()
  })
})
