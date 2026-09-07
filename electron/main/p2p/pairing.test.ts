import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerPairing } from './pairing'
import { peerFingerprint } from './pair-records'

const serviceId = 'a'.repeat(64)
const localDevice = '1'.repeat(32)
const remoteDevice = '2'.repeat(32)
const networkId = '3'.repeat(32)
const pairId = '4'.repeat(32)
const userId = '5'.repeat(32)
const signal = () => AbortSignal.timeout(5000)

/** Distinct 32-byte Ed25519-sized keys, so fingerprints differ. */
const localKey = Buffer.alloc(32, 7)
const remoteKey = Buffer.alloc(32, 9)
const substitutedKey = Buffer.alloc(32, 11)

const remoteFingerprint = peerFingerprint(remoteKey)
const substitutedFingerprint = peerFingerprint(substitutedKey)

afterEach(() => vi.restoreAllMocks())

function device(deviceId: string, key: Buffer, presence = 'online') {
  return {
    deviceId,
    userId,
    publicKey: key.toString('base64'),
    name: `dev-${deviceId.slice(0, 4)}`,
    presence
  }
}

function identity(state: string, remote = remoteKey) {
  return {
    pair: {
      pairId,
      networkId,
      initiator: localDevice,
      target: remoteDevice,
      state,
      expiresAt: 1_800_000_000,
      revision: 3
    },
    initiator: device(localDevice, localKey),
    target: device(remoteDevice, remote)
  }
}

function fixture() {
  const call = vi.fn<(method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>>()
  const revoked = vi.fn(async (_service: string, _pair: string) => undefined)
  const pairing = new PeerPairing({ call }, async () => localDevice, revoked)
  return { call, revoked, pairing }
}

describe('main-owned P2P pairing', () => {
  it('derives the confirmation fingerprint from the real key rather than trusting the reply', async () => {
    // A reply cannot smuggle its own fingerprint: the value the user confirms is
    // computed locally from the actual public key.
    const expected = createHash('sha256').update(remoteKey).digest('hex').slice(0, 32)
    expect(remoteFingerprint.replace(/ /g, '')).toBe(expected)
  })

  it('refuses approval when the confirmed fingerprint does not match the remote key', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce(identity('approved'))
    await expect(
      f.pairing.approve(serviceId, pairId, substitutedFingerprint, signal())
    ).rejects.toMatchObject({ code: 'p2p.pair_fingerprint_mismatch' })
    // No approval was ever sent.
    expect(f.call.mock.calls.map((call) => call[0])).toEqual(['pairs.identity'])
  })

  it('rejects an identity substituted between confirmation and readback', async () => {
    const f = fixture()
    f.call
      .mockResolvedValueOnce(identity('approved'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(identity('active', substitutedKey))
    await expect(
      f.pairing.approve(serviceId, pairId, remoteFingerprint, signal())
    ).rejects.toMatchObject({ code: 'p2p.identity_mismatch' })
    // The substituted identity must not be pinned.
    expect(f.call.mock.calls.map((call) => call[0])).not.toContain('pairs.pin')
  })

  it('pins the confirmed identity only once the server reports the pair active', async () => {
    const f = fixture()
    f.call
      .mockResolvedValueOnce(identity('approved'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(identity('active'))
      .mockResolvedValueOnce({})
    const pair = await f.pairing.approve(serviceId, pairId, remoteFingerprint, signal())
    expect(pair.state).toBe('active')
    expect(f.call.mock.calls.map((call) => call[0])).toEqual([
      'pairs.identity',
      'pairs.action',
      'pairs.identity',
      'pairs.pin'
    ])
  })

  it('does not pin when approval leaves the pair still pending', async () => {
    const f = fixture()
    f.call
      .mockResolvedValueOnce(identity('approved'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(identity('approved'))
    const pair = await f.pairing.approve(serviceId, pairId, remoteFingerprint, signal())
    expect(pair.state).toBe('approved')
    expect(f.call.mock.calls.map((call) => call[0])).not.toContain('pairs.pin')
  })

  it('refuses to approve a pair that is not pending', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce(identity('revoked'))
    await expect(
      f.pairing.approve(serviceId, pairId, remoteFingerprint, signal())
    ).rejects.toMatchObject({ code: 'p2p.pair_state_mismatch' })
  })

  it('reads back the authoritative record instead of trusting the invite write reply', async () => {
    const f = fixture()
    f.call
      .mockResolvedValueOnce({ pairId })
      .mockResolvedValueOnce(identity('invited'))
    const pair = await f.pairing.acceptInvite(serviceId, networkId, 'A'.repeat(24), signal())
    expect(pair.state).toBe('invited')
    expect(f.call.mock.calls.map((call) => call[0])).toEqual(['pairs.invite', 'pairs.identity'])
  })

  it('never returns an active pair straight from accepting an invite', async () => {
    const f = fixture()
    f.call
      .mockResolvedValueOnce({ pairId })
      .mockResolvedValueOnce(identity('approved'))
    const pair = await f.pairing.acceptInvite(serviceId, networkId, 'A'.repeat(24), signal())
    expect(pair.state).not.toBe('active')
  })

  it('rejects a malformed invite code before any call is made', async () => {
    const f = fixture()
    // Input validation is synchronous by design: a bad code never reaches the helper.
    expect(() => f.pairing.acceptInvite(serviceId, networkId, 'too-short', signal())).toThrow(
      expect.objectContaining({ code: 'p2p.invite_invalid' })
    )
    expect(f.call).not.toHaveBeenCalled()
  })

  it('runs owner cleanup after the server accepts a revocation', async () => {
    const f = fixture()
    f.call.mockResolvedValueOnce({}).mockResolvedValueOnce(identity('revoked'))
    const pair = await f.pairing.revoke(serviceId, pairId, signal())
    expect(pair.state).toBe('revoked')
    expect(f.revoked).toHaveBeenCalledWith(serviceId, pairId)
  })

  it('refuses a concurrent pairing operation on the same service', async () => {
    const f = fixture()
    let release = (): void => {}
    f.call.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(identity('active'))))
    )
    const first = f.pairing.identity(serviceId, pairId, signal())
    await expect(f.pairing.identity(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.service_busy'
    })
    release()
    await first
  })

  it('rejects a pair that names neither local nor a known remote device', async () => {
    const f = fixture()
    const foreign = identity('active')
    foreign.pair.initiator = '9'.repeat(32)
    foreign.initiator = device('9'.repeat(32), localKey)
    await expect(
      (async () => {
        f.call.mockResolvedValueOnce(foreign)
        return f.pairing.identity(serviceId, pairId, signal())
      })()
    ).rejects.toMatchObject({ code: 'p2p.identity_mismatch' })
  })

  it('rejects a reply whose pairId does not match the request', async () => {
    const f = fixture()
    const other = identity('active')
    other.pair.pairId = '8'.repeat(32)
    f.call.mockResolvedValueOnce(other)
    await expect(f.pairing.identity(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.identity_mismatch'
    })
  })

  it('refuses an operation once closed', async () => {
    const f = fixture()
    f.pairing.close()
    await expect(f.pairing.identity(serviceId, pairId, signal())).rejects.toMatchObject({
      code: 'p2p.helper_closed'
    })
  })
})
