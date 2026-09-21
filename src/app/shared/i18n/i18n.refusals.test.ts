import { describe, expect, it } from 'vitest'
import { enUSRefusals, refusalKeyForCode, zhCNRefusals } from './i18n.refusals'

/**
 * A failed connection tells the user which side is the problem. The codes come
 * from the core and the coordinator, which answer with far more of them than
 * anyone writes copy for, so the mapping is by category and has to cover the ones
 * a user actually hits: this computer not being set up, a coordinator that cannot
 * be reached, an offline peer, a network that cannot be crossed, a workbench that
 * did not start, and an authorization that is gone.
 */
describe('connection refusal copy', () => {
  it('names the side that failed for every code a user meets', () => {
    expect(refusalKeyForCode('p2p.peer_offline')).toBe('p2p.refusal.peerOffline')
    expect(refusalKeyForCode('p2p.direct_unavailable')).toBe('p2p.refusal.noDirectPath')
    expect(refusalKeyForCode('p2p.runtime_unavailable')).toBe('p2p.refusal.runtimeUnavailable')
    expect(refusalKeyForCode('p2p.runtime_timeout')).toBe('p2p.refusal.runtimeUnavailable')
    expect(refusalKeyForCode('p2p.pair_unauthorized')).toBe('p2p.refusal.pairUnauthorized')
    expect(refusalKeyForCode('p2p.network_revoked')).toBe('p2p.refusal.pairUnauthorized')
    expect(refusalKeyForCode('p2p.connection_busy')).toBe('p2p.refusal.connecting')
  })

  /**
   * A failure raised on this side must not be blamed on the other computer: the
   * user would go and check a machine that is working. `p2p.not_enabled` is
   * refused before any peer is contacted at all.
   */
  it('blames this computer for a refusal raised before the peer was contacted', () => {
    expect(refusalKeyForCode('p2p.not_enabled')).toBe('p2p.refusal.localNotReady')
    expect(refusalKeyForCode('p2p.device_unregistered')).toBe('p2p.refusal.localNotReady')
    expect(refusalKeyForCode('p2p.helper_unavailable')).toBe('p2p.refusal.localNotReady')
    expect(refusalKeyForCode('p2p.not_connected')).toBe('p2p.refusal.notConnected')
  })

  /**
   * A superseded attempt is an ordinary state of a tab, not a fault.
   *
   * `p2p.stale_generation` used to fall through to the generic failure text, which
   * told the user nothing and offered no action. It belongs with the refusals that
   * mean "this computer no longer holds that connection", because reconnecting is
   * exactly what resolves it.
   */
  it('reads a superseded attempt as a lost connection rather than a fault', () => {
    expect(refusalKeyForCode('p2p.stale_generation')).toBe('p2p.refusal.notConnected')
    expect(refusalKeyForCode('p2p.stale_generation')).not.toBe('p2p.refusal.fault')
  })

  /** The server that introduces the two computers is a third party to the failure. */
  it('separates a coordinator that cannot be reached from a network that cannot be crossed', () => {
    expect(refusalKeyForCode('p2p.server_unavailable')).toBe('p2p.refusal.coordinatorUnavailable')
    expect(refusalKeyForCode('p2p.direct_unavailable')).not.toBe(
      'p2p.refusal.coordinatorUnavailable'
    )
  })

  /**
   * The workbench's own codes belong to the managed-harness subsystem and reach a
   * peer tab verbatim now that the core stops flattening them. Every one of them
   * means the launch behind the peer was refused, so the whole family maps to the
   * one line that says so rather than to the generic fault.
   */
  it('reads a workbench launch refusal as a workbench launch refusal', () => {
    expect(refusalKeyForCode('runtime.port_in_use')).toBe('p2p.refusal.runtimeUnavailable')
    expect(refusalKeyForCode('managed.harness_port_in_use')).toBe('p2p.refusal.runtimeUnavailable')
    expect(refusalKeyForCode('runtime.child_crashed')).toBe('p2p.refusal.runtimeUnavailable')
  })

  it('falls back to a true generic line for a code nobody wrote copy for', () => {
    const fallback = refusalKeyForCode('p2p.something_new')
    expect(fallback).toBe('p2p.refusal.fault')
    // The fallback has to stay true of any failure, because it is what an
    // unfamiliar code inherits.
    expect(zhCNRefusals[fallback]).toContain('操作未成功')
    expect(enUSRefusals[fallback]).toContain('did not succeed')
  })

  it('keeps both languages complete for every category', () => {
    expect(Object.keys(enUSRefusals).sort()).toEqual(Object.keys(zhCNRefusals).sort())
    for (const key of Object.keys(zhCNRefusals) as (keyof typeof zhCNRefusals)[]) {
      expect(zhCNRefusals[key].length).toBeGreaterThan(0)
      expect(enUSRefusals[key].length).toBeGreaterThan(0)
    }
  })
})
