import { createHash } from 'node:crypto'
import { assertAccountId, assertAccountText } from './account-records'
import { exactPeerObject, PeerHelperError } from './wire'

/**
 * Pairing records as validated at the main boundary.
 *
 * The helper is trusted to speak the protocol but not to supply well-formed
 * business data: every field is checked here so a malformed or hostile reply
 * cannot reach persistence or the renderer. Fingerprints are derived locally
 * from the real public key rather than taken from the reply, so a server cannot
 * present one key and a different fingerprint for the user to confirm.
 */

/** Server-declared pair states, mapped 1:1 from the Go coordinator. */
/** Server state machine values; anything else is a broken reply. */
const PAIR_STATES = ['invited', 'approved', 'active', 'rejected', 'revoked'] as const
export type PeerPairState = (typeof PAIR_STATES)[number]

/**
 * Presence values the coordinator can report.
 *
 * `stale` means the last heartbeat is older than the server's liveness window.
 * It has to be accepted here: the coordinator returns it from the same call that
 * backs pair identity, so rejecting it would make a device whose heartbeat is
 * merely a few seconds late fail the whole read. It is narrowed to `offline`
 * when projected, because a stale heartbeat must never read as usable.
 */
const PRESENCE = ['online', 'stale', 'offline'] as const
type PeerReportedPresence = (typeof PRESENCE)[number]
export type PeerPresence = 'online' | 'offline'

/** A heartbeat that has gone stale is not a usable connection. */
function usablePresence(value: PeerReportedPresence): PeerPresence {
  return value === 'online' ? 'online' : 'offline'
}

export interface PeerPairDevice {
  deviceId: string
  userId: string
  name: string
  fingerprint: string
  presence: PeerPresence
}

export interface PeerPair {
  pairId: string
  networkId: string
  state: PeerPairState
  revision: number
  expiresAt: number
  initiator: PeerPairDevice
  target: PeerPairDevice
  localIsInitiator: boolean
}

export interface PeerInvite {
  code: string
  networkId: string
  expiresAt: number
}

/**
 * Derives the user-facing fingerprint from the actual device public key.
 *
 * Grouped hex of a SHA-256 digest: short enough to read aloud when confirming a
 * pair out of band, and never the key material itself.
 */
export function peerFingerprint(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest('hex')
  return (digest.slice(0, 32).match(/.{4}/g) ?? []).join(' ')
}

function peerPublicKey(value: unknown): Buffer {
  // Go marshals []byte as base64 in JSON.
  if (typeof value !== 'string' || value.length === 0)
    throw new PeerHelperError('p2p.invalid_device_key')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 32) throw new PeerHelperError('p2p.invalid_device_key')
  return decoded
}

function peerPairDevice(value: unknown): PeerPairDevice {
  const record = exactPeerObject(value, ['deviceId', 'userId', 'publicKey', 'name', 'presence'])
  assertAccountId(record.deviceId)
  assertAccountId(record.userId)
  assertAccountText(record.name)
  if (!PRESENCE.includes(record.presence as PeerReportedPresence))
    throw new PeerHelperError('p2p.invalid_device_state')
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    name: record.name,
    fingerprint: peerFingerprint(peerPublicKey(record.publicKey)),
    presence: usablePresence(record.presence as PeerReportedPresence)
  }
}

function peerPairCore(value: unknown): Omit<PeerPair, 'initiator' | 'target' | 'localIsInitiator'> {
  const record = exactPeerObject(value, [
    'pairId',
    'networkId',
    'initiator',
    'target',
    'state',
    'expiresAt',
    'revision'
  ])
  assertAccountId(record.pairId)
  assertAccountId(record.networkId)
  assertAccountId(record.initiator)
  assertAccountId(record.target)
  if (!PAIR_STATES.includes(record.state as PeerPairState))
    throw new PeerHelperError('p2p.pair_state_mismatch')
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)
    throw new PeerHelperError('p2p.invalid_payload')
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0)
    throw new PeerHelperError('p2p.invalid_payload')
  return {
    pairId: record.pairId,
    networkId: record.networkId,
    state: record.state as PeerPairState,
    revision: record.revision as number,
    expiresAt: record.expiresAt as number
  }
}

/**
 * Validates one `pairs.identity` reply.
 *
 * `localDeviceId` decides which side this device is on, which in turn decides
 * whether approval or fingerprint confirmation is the available action. A pair
 * that names neither side is rejected rather than shown as unrelated.
 */
export function peerPairIdentity(value: unknown, localDeviceId: string): PeerPair {
  const record = exactPeerObject(value, ['pair', 'initiator', 'target'])
  const pair = peerPairCore(record.pair)
  const initiator = peerPairDevice(record.initiator)
  const target = peerPairDevice(record.target)
  if (initiator.deviceId !== (record.pair as { initiator: string }).initiator)
    throw new PeerHelperError('p2p.identity_mismatch')
  if (target.deviceId !== (record.pair as { target: string }).target)
    throw new PeerHelperError('p2p.identity_mismatch')
  if (localDeviceId !== initiator.deviceId && localDeviceId !== target.deviceId)
    throw new PeerHelperError('p2p.identity_mismatch')
  return { ...pair, initiator, target, localIsInitiator: localDeviceId === initiator.deviceId }
}

/** A device side of a pair, with the real public key retained for main-owned use. */
export interface PeerPairMemberDevice {
  deviceId: string
  userId: string
  name: string
  publicKey: string
  presence: PeerPresence
}

/**
 * One pair with both real identities, including their public keys.
 *
 * The catalog the Run route reads stores those keys and a re-pin needs them, and
 * both live only in main. `PeerPair` deliberately projects them down to
 * fingerprints for the renderer, so this is the separate main-internal shape.
 */
export interface PeerPairMember {
  pairId: string
  networkId: string
  state: PeerPairState
  revision: number
  expiresAt: number
  initiator: PeerPairMemberDevice
  target: PeerPairMemberDevice
}

function peerPairMemberDevice(value: unknown): PeerPairMemberDevice {
  const record = exactPeerObject(value, ['deviceId', 'userId', 'publicKey', 'name', 'presence'])
  assertAccountId(record.deviceId)
  assertAccountId(record.userId)
  assertAccountText(record.name)
  if (!PRESENCE.includes(record.presence as PeerReportedPresence))
    throw new PeerHelperError('p2p.invalid_device_state')
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    name: record.name,
    // Canonical base64, so the catalog's own base64 round-trip check holds.
    publicKey: peerPublicKey(record.publicKey).toString('base64'),
    presence: usablePresence(record.presence as PeerReportedPresence)
  }
}

/**
 * Validates one `pairs.identity` reply and keeps both public keys.
 *
 * This is what lets main build the catalog: the network device directory
 * deliberately withholds credential material, and a pair identity is the only
 * place this device is handed the peer's real key.
 */
export function peerPairMember(value: unknown, localDeviceId: string): PeerPairMember {
  const record = exactPeerObject(value, ['pair', 'initiator', 'target'])
  const pair = peerPairCore(record.pair)
  const initiator = peerPairMemberDevice(record.initiator)
  const target = peerPairMemberDevice(record.target)
  const sides = record.pair as { initiator: string; target: string }
  if (initiator.deviceId !== sides.initiator || target.deviceId !== sides.target)
    throw new PeerHelperError('p2p.identity_mismatch')
  if (initiator.deviceId === target.deviceId || initiator.publicKey === target.publicKey)
    throw new PeerHelperError('p2p.identity_mismatch')
  if (localDeviceId !== initiator.deviceId && localDeviceId !== target.deviceId)
    throw new PeerHelperError('p2p.identity_mismatch')
  return { ...pair, initiator, target }
}

/** Validates a `pairs.list` reply; duplicate pair ids indicate a broken source. */
export function peerPairs(value: unknown, localDeviceId: string): PeerPair[] {
  if (!Array.isArray(value)) throw new PeerHelperError('p2p.invalid_payload')
  const pairs = value.map((record) => {
    const core = peerPairCore(record)
    const raw = record as { initiator: string; target: string }
    if (localDeviceId !== raw.initiator && localDeviceId !== raw.target)
      throw new PeerHelperError('p2p.identity_mismatch')
    // `pairs.list` carries ids only; identities arrive through pairs.identity.
    const placeholder = (deviceId: string): PeerPairDevice => ({
      deviceId,
      userId: deviceId,
      name: deviceId,
      fingerprint: '',
      presence: 'offline'
    })
    return {
      ...core,
      initiator: placeholder(raw.initiator),
      target: placeholder(raw.target),
      localIsInitiator: localDeviceId === raw.initiator
    }
  })
  if (new Set(pairs.map((pair) => pair.pairId)).size !== pairs.length)
    throw new PeerHelperError('p2p.invalid_payload')
  return pairs
}

/** Validates a `pairs.share` reply. The code is a bearer secret, never persisted. */
export function peerInvite(value: unknown, networkId: string): PeerInvite {
  const record = exactPeerObject(value, ['code', 'expiresAt'])
  // The code is base64url of the signed share record (~520 chars for the real
  // field sizes); 2048 leaves room without admitting arbitrary blobs.
  if (typeof record.code !== 'string' || !/^[A-Za-z0-9_-]{16,2048}$/.test(record.code))
    throw new PeerHelperError('p2p.invite_invalid')
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0)
    throw new PeerHelperError('p2p.invite_invalid')
  return { code: record.code, networkId, expiresAt: record.expiresAt as number }
}

/** Fingerprint the user confirmed; format must match what the UI displayed. */
export function assertConfirmedFingerprint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^([a-f0-9]{4} ){7}[a-f0-9]{4}$/.test(value))
    throw new PeerHelperError('p2p.pair_fingerprint_mismatch')
}
