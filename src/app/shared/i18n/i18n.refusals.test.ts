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
  it('explains an unbound selected account without replacing it with the enrollment owner', () => {
    const key = refusalKeyForCode('p2p.binding_unauthorized')
    expect(key).toBe('p2p.refusal.accountNotBound')
    expect(zhCNRefusals[key]).toContain('不会改用其他账号')
    expect(enUSRefusals[key]).toContain('another account will not be substituted')
  })

  it('explains every new candidate refusal without calling it an unreachable server', () => {
    const groups = {
      recoveryUnsupported: ['candidate_unsupported'],
      recoveryChanged: ['registration_stale', 'active_changed', 'core_replaced', 'account_changed'],
      recoveryPending: ['candidate_not_ready'],
      recoveryRefused: [
        'candidate_scope_mismatch',
        'candidate_conflict',
        'candidate_state_conflict',
        'source_required'
      ],
      recoveryEnded: [
        'candidate_expired',
        'candidate_cancelled',
        'attempt_not_active',
        'connection_ended'
      ],
      coordinatorRestarted: ['coordinator_restarted']
    } as const
    for (const [category, codes] of Object.entries(groups))
      for (const code of codes) {
        const key = refusalKeyForCode(`p2p.${code}`)
        expect(key).toBe(`p2p.refusal.${category}`)
        expect(zhCNRefusals[key]).not.toContain('连不上协调服务器')
        expect(enUSRefusals[key]).not.toContain('could not be reached')
      }
  })

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

  it('does not describe lost runtime authority as a stopped workbench', () => {
    const unavailable = refusalKeyForCode('runtime.owner_unavailable')
    expect(unavailable).toBe('p2p.refusal.runtimeOwnerUnavailable')
    expect(zhCNRefusals[unavailable]).toContain('未尝试重新启动')
    expect(enUSRefusals[unavailable]).toContain('not restarted')
    for (const code of [
      'runtime.owner_identity_mismatch',
      'runtime.owner_record_invalid',
      'runtime.owner_protocol_unsupported',
      'runtime.owner_configuration_invalid'
    ]) {
      expect(refusalKeyForCode(code)).toBe('p2p.refusal.runtimeOwnerInvalid')
    }
    expect(refusalKeyForCode('runtime.owner_shutdown_failed')).toBe(
      'p2p.refusal.runtimeOwnerShutdown'
    )
  })

  it('falls back to a true generic line for a code nobody wrote copy for', () => {
    const fallback = refusalKeyForCode('p2p.something_new')
    expect(fallback).toBe('p2p.refusal.fault')
    // The fallback has to stay true of any failure, because it is what an
    // unfamiliar code inherits.
    expect(zhCNRefusals[fallback]).toContain('操作未成功')
    expect(enUSRefusals[fallback]).toContain('did not succeed')
  })

  it('explains certificate recovery without asking for replacement enrollment or pairing', () => {
    const required = refusalKeyForCode('p2p.certificate_recovery_required')
    const forbidden = refusalKeyForCode('p2p.certificate_recovery_forbidden')
    expect(required).toBe('p2p.refusal.certificateRecoveryRequired')
    expect(forbidden).toBe('p2p.refusal.certificateRecoveryForbidden')
    expect(zhCNRefusals[required]).toContain('原网络所有者')
    expect(zhCNRefusals[forbidden]).toContain('无权')
    expect(enUSRefusals[required]).toContain('device and pairs are retained')
    expect(enUSRefusals[forbidden]).toContain('cannot recover')
    expect(refusalKeyForCode('p2p.invalid_device_certificate')).toBe(
      'p2p.refusal.invalidDeviceCertificate'
    )
    const unreadable = refusalKeyForCode('p2p.credential_read_failed')
    expect(unreadable).toBe('p2p.refusal.credentialReadFailed')
    expect(zhCNRefusals[unreadable]).toContain('原设备和配对会保留')
    expect(enUSRefusals[unreadable]).toContain('could not be read')
  })

  it('keeps both languages complete for every category', () => {
    expect(Object.keys(enUSRefusals).sort()).toEqual(Object.keys(zhCNRefusals).sort())
    for (const key of Object.keys(zhCNRefusals) as (keyof typeof zhCNRefusals)[]) {
      expect(zhCNRefusals[key].length).toBeGreaterThan(0)
      expect(enUSRefusals[key].length).toBeGreaterThan(0)
    }
  })

  it('distinguishes certificate synchronization from system credential persistence failures', () => {
    const sync = refusalKeyForCode('p2p.certificate_sync_failed')
    const persist = refusalKeyForCode('p2p.certificate_persist_failed')
    expect(sync).toBe('p2p.refusal.certificateSyncFailed')
    expect(persist).toBe('p2p.refusal.certificatePersistFailed')
    expect(zhCNRefusals[sync]).toContain('网络设备证书同步失败')
    expect(enUSRefusals[sync]).toContain('could not be synchronized')
    expect(zhCNRefusals[persist]).toContain('系统凭据存储')
    expect(enUSRefusals[persist]).toContain('could not be saved to the system credential store')
    expect(zhCNRefusals[sync]).toContain('原设备和配对会保留')
    expect(zhCNRefusals[persist]).toContain('原设备和配对会保留')
  })
})
