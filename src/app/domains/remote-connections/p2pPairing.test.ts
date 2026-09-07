import { describe, expect, it, vi } from 'vitest'
import type { P2PManagementApi, P2PPairView } from '@/shared/p2p-management'
import { P2PManagementDomain } from './p2pManagement'
import { P2PPairingDomain } from './p2pPairing'

const serviceId = 'service-a'
const networkId = 'network-a'
const pairId = 'pair-a'
const fingerprint = ['1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888'].join(' ')

function device(deviceId: string, presence: 'online' | 'offline' = 'online') {
  return { deviceId, userId: 'user-a', name: `dev-${deviceId}`, fingerprint, presence }
}
function pair(state: P2PPairView['state']): P2PPairView {
  return {
    pairId,
    networkId,
    state,
    revision: 2,
    expiresAt: 1_800_000_000,
    initiator: device('local'),
    target: device('remote', 'offline'),
    localIsInitiator: true
  }
}

function setup() {
  const api = {
    pairs: vi
      .fn<P2PManagementApi['pairs']>()
      .mockResolvedValue({ ok: true, data: [pair('active')] }),
    pairIdentity: vi
      .fn<P2PManagementApi['pairIdentity']>()
      .mockResolvedValue({ ok: true, data: pair('pending_target_approval') }),
    createInvite: vi.fn<P2PManagementApi['createInvite']>().mockResolvedValue({
      ok: true,
      data: { code: 'ABCDEFGHIJKLMNOP', networkId, expiresAt: 1_800_000_000 }
    }),
    acceptInvite: vi
      .fn<P2PManagementApi['acceptInvite']>()
      .mockResolvedValue({ ok: true, data: pair('pending_target_approval') }),
    approvePair: vi
      .fn<P2PManagementApi['approvePair']>()
      .mockResolvedValue({ ok: true, data: pair('active') }),
    rejectPair: vi
      .fn<P2PManagementApi['rejectPair']>()
      .mockResolvedValue({ ok: true, data: pair('revoked') }),
    revokePair: vi.fn<P2PManagementApi['revokePair']>()
  }
  const management = new P2PManagementDomain(() => api as unknown as P2PManagementApi)
  return { api, pairing: new P2PPairingDomain(management) }
}

describe('renderer P2P pairing domain', () => {
  it('shows a minted invite exactly once and does not keep it readable', async () => {
    const { pairing } = setup()
    await pairing.createInvite(serviceId, networkId)
    expect(pairing.state(serviceId).issuedInvite?.code).toBe('ABCDEFGHIJKLMNOP')
    pairing.dismissInvite(serviceId)
    expect(pairing.state(serviceId).issuedInvite).toBeUndefined()
  })

  it('requires a confirmed fingerprint before an approval is dispatched', async () => {
    const { api, pairing } = setup()
    await pairing.review(serviceId, pairId)
    // No confirmation typed yet.
    await pairing.approve(serviceId)
    expect(api.approvePair).not.toHaveBeenCalled()
  })

  it('sends the exact fingerprint the user confirmed', async () => {
    const { api, pairing } = setup()
    await pairing.review(serviceId, pairId)
    pairing.state(serviceId).confirmDraft = fingerprint
    await pairing.approve(serviceId)
    expect(api.approvePair).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId, pairId, fingerprint })
    )
  })

  it('treats a refused fingerprint as a definite answer, not an unknown result', async () => {
    const { api, pairing } = setup()
    api.approvePair.mockResolvedValue({
      ok: false,
      code: 'p2p.pair_fingerprint_mismatch',
      message: 'mismatch'
    })
    await pairing.review(serviceId, pairId)
    pairing.state(serviceId).confirmDraft = fingerprint
    await pairing.approve(serviceId)
    const state = pairing.state(serviceId)
    expect(state.resultUnconfirmed).toBe(false)
    // A definite refusal must not block the next attempt.
    api.approvePair.mockResolvedValue({ ok: true, data: pair('active') })
    state.confirmDraft = fingerprint
    await pairing.approve(serviceId)
    expect(api.approvePair).toHaveBeenCalledTimes(2)
  })

  it('blocks further writes after a write whose outcome is unknown', async () => {
    const { api, pairing } = setup()
    api.acceptInvite.mockResolvedValue({
      ok: false,
      code: 'p2p.server_unavailable',
      message: 'unknown'
    })
    const state = pairing.state(serviceId)
    state.codeDraft = 'ABCDEFGHIJKLMNOP'
    await pairing.acceptInvite(serviceId, networkId)
    expect(state.resultUnconfirmed).toBe(true)
    // A second write must not be attempted while the first outcome is unknown.
    state.codeDraft = 'ABCDEFGHIJKLMNOP'
    await pairing.acceptInvite(serviceId, networkId)
    expect(api.acceptInvite).toHaveBeenCalledTimes(1)
  })

  it('lets a readback clear an unknown outcome so the user can proceed', async () => {
    const { api, pairing } = setup()
    api.createInvite.mockResolvedValue({
      ok: false,
      code: 'p2p.server_unavailable',
      message: 'unknown'
    })
    await pairing.createInvite(serviceId, networkId)
    expect(pairing.state(serviceId).resultUnconfirmed).toBe(true)
    await pairing.read(serviceId)
    expect(pairing.state(serviceId).resultUnconfirmed).toBe(false)
  })

  it('keeps the code draft when accepting an invite fails so a typo is correctable', async () => {
    const { api, pairing } = setup()
    api.acceptInvite.mockResolvedValue({
      ok: false,
      code: 'p2p.invite_invalid',
      message: 'invalid'
    })
    const state = pairing.state(serviceId)
    state.codeDraft = 'ABCDEFGHIJKLMNOP'
    await pairing.acceptInvite(serviceId, networkId)
    expect(state.codeDraft).toBe('ABCDEFGHIJKLMNOP')
  })

  it('never reports a pending pair as active after accepting an invite', async () => {
    const { pairing } = setup()
    const state = pairing.state(serviceId)
    state.codeDraft = 'ABCDEFGHIJKLMNOP'
    await pairing.acceptInvite(serviceId, networkId)
    expect(state.reviewing?.state).toBe('pending_target_approval')
  })

  it('resolves the remote side regardless of which end this device is', () => {
    const { pairing } = setup()
    const asInitiator = pair('active')
    expect(pairing.remoteOf(asInitiator).deviceId).toBe('remote')
    const asTarget = { ...pair('active'), localIsInitiator: false }
    expect(pairing.remoteOf(asTarget).deviceId).toBe('local')
  })

  it('clears the review pane once the pair becomes active', async () => {
    const { pairing } = setup()
    await pairing.review(serviceId, pairId)
    pairing.state(serviceId).confirmDraft = fingerprint
    await pairing.approve(serviceId)
    expect(pairing.state(serviceId).reviewing).toBeUndefined()
  })

  it('keeps the review pane open when approval leaves the pair pending', async () => {
    const { api, pairing } = setup()
    api.approvePair.mockResolvedValue({
      ok: true,
      data: pair('pending_initiator_confirmation')
    })
    await pairing.review(serviceId, pairId)
    pairing.state(serviceId).confirmDraft = fingerprint
    await pairing.approve(serviceId)
    expect(pairing.state(serviceId).reviewing?.state).toBe('pending_initiator_confirmation')
  })

  it('refreshes the list after a revocation so no stale active pair remains', async () => {
    const { api, pairing } = setup()
    api.revokePair.mockResolvedValue({
      ok: true,
      data: {
        revision: 'r',
        catalogId: 'c',
        services: [],
        computers: [],
        forgottenServiceIds: []
      }
    })
    api.pairs.mockResolvedValue({ ok: true, data: [pair('revoked')] })
    await pairing.revoke(serviceId, pairId)
    expect(pairing.state(serviceId).pairs?.[0]?.state).toBe('revoked')
  })
})
