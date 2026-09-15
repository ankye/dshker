import {
  P2P_NETWORK_DEVICE_LIMITS,
  type P2PNetworkDeviceLimit
} from '../../../src/shared/p2p-management'
import { exactPeerObject, PeerHelperError } from './wire'

export interface PeerUser {
  userId: string
  username: string
}
export interface PeerNetwork {
  networkId: string
  userId: string
  name: string
  /** Server-confirmed device capacity; the server is authoritative. */
  maxDevices: P2PNetworkDeviceLimit
}
/**
 * A device bound to a network, as its owner sees it.
 *
 * No certificate: the coordinator withholds credential material from its
 * directory, and nothing here needs it.
 */
export interface PeerNetworkDevice {
  deviceId: string
  userId: string
  name: string
  presence: 'online' | 'offline'
  /** Unix seconds, 0 when never reported. Persisted at most once a minute. */
  lastSeen: number
  version: string
  platform: string
  architecture: string
}
/** Private main memory only. Never return this type from renderer-facing methods. */
export interface PeerUserSession {
  user: PeerUser
  token: string
  expiresAt: number
}

/** One owned network's members, as a single directory snapshot reports them. */
export interface PeerNetworkDirectory extends PeerNetwork {
  devices: PeerNetworkDevice[]
}

/**
 * The core's whole directory snapshot for one service.
 *
 * One value, because the directory now has one owner: the account's own bound
 * devices and every owned network's members are read together and cached
 * together, so two pages can no longer hold different answers. `known:false`
 * with empty lists is "this process has not read yet", which the shell reports
 * as a state rather than as a failure.
 */
export interface PeerDirectory {
  known: boolean
  revision: number
  fetchedAt: number
  networks: PeerNetworkDirectory[]
  devices: PeerNetworkDevice[]
}

export function peerUser(value: unknown): PeerUser {
  const record = exactPeerObject(value, ['userId', 'username'])
  assertAccountId(record.userId)
  // The coordinator identifies every account by email and returns that address
  // as the username, so the projection must accept an address here. Validating
  // it with assertAccountUsername rejected every real user, registered or not.
  assertAccountIdentity(record.username)
  return { userId: record.userId, username: record.username }
}

export function peerUserSession(value: unknown): PeerUserSession {
  const record = exactPeerObject(value, ['user', 'token', 'expiresAt'])
  if (
    typeof record.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.token) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0
  )
    throw new PeerHelperError('p2p.invalid_user_session')
  return { user: peerUser(record.user), token: record.token, expiresAt: record.expiresAt as number }
}

export function peerNetwork(value: unknown, userId: string): PeerNetwork {
  const record = exactPeerObject(value, ['networkId', 'userId', 'name', 'maxDevices'])
  assertAccountId(record.networkId)
  assertAccountText(record.name)
  if (record.userId !== userId) throw new PeerHelperError('p2p.user_scope_mismatch')
  if (!(P2P_NETWORK_DEVICE_LIMITS as readonly number[]).includes(record.maxDevices as number))
    throw new PeerHelperError('p2p.invalid_network_limit')
  return {
    networkId: record.networkId,
    userId,
    name: record.name,
    maxDevices: record.maxDevices as P2PNetworkDeviceLimit
  }
}

/**
 * One row of a device directory: a network's members, or the account's own.
 *
 * Telemetry is self-declared, so it is validated for shape but never trusted for
 * meaning: an over-long or control-character value is dropped to empty rather
 * than refusing the whole directory, because a cosmetic field must not hide the
 * device list. Presence follows the pair rule: stale is not usable, so it reads
 * as offline.
 *
 * The row's own `userId` is deliberately not compared with the account this list
 * was read for. That column is the account that first enrolled the machine, while
 * the list itself is already scoped to the reader's account by the coordinator; a
 * machine bound to two accounts — enrolled under one and added to the other's
 * network by hand — would otherwise make the whole directory unreadable with a
 * scope mismatch. The account a row is reported for is the caller's, since that is
 * the only scope the request could have had.
 */
export function peerNetworkDevice(value: unknown, userId: string): PeerNetworkDevice {
  const record = exactPeerObject(value, [
    'deviceId',
    'userId',
    'name',
    'presence',
    'lastSeen',
    'version',
    'platform',
    'architecture'
  ])
  assertAccountId(record.deviceId)
  assertAccountId(record.userId)
  assertAccountText(record.name)
  if (!['online', 'stale', 'offline'].includes(record.presence as string))
    throw new PeerHelperError('p2p.invalid_device_state')
  if (!Number.isSafeInteger(record.lastSeen) || (record.lastSeen as number) < 0)
    throw new PeerHelperError('p2p.invalid_device_state')
  return {
    deviceId: record.deviceId,
    userId,
    name: record.name,
    presence: record.presence === 'online' ? 'online' : 'offline',
    lastSeen: record.lastSeen as number,
    version: displayable(record.version),
    platform: displayable(record.platform),
    architecture: displayable(record.architecture)
  }
}

/** Keeps a self-declared string only when it is safe to render as-is. */
function displayable(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) return ''
  return /[\r\n\u0000]/.test(value) || value !== value.trim() ? '' : value
}

/**
 * Validates the core's directory reply for one service and one account.
 *
 * Rows go through `peerNetwork` and `peerNetworkDevice`, so the row vocabulary is
 * validated in one place instead of being re-stated per reader. Anything those
 * projections or this envelope refuse becomes p2p.invalid_server_response: the
 * core relays what the coordinator said, and a directory that is only half
 * readable would show a list silently missing devices, which is worse than
 * refusing it. `known:false` with empty lists is a legitimate answer and is not
 * an error — it means the core has not read the coordinator yet.
 */
export function peerDirectory(value: unknown, serviceId: string, userId: string): PeerDirectory {
  try {
    const record = exactPeerObject(value, [
      'serviceId',
      'known',
      'revision',
      'fetchedAt',
      'networks',
      'devices'
    ])
    const known = record.known
    const revision = record.revision
    const fetchedAt = record.fetchedAt
    const networks = record.networks
    const devices = record.devices
    // A reply about another service is not this service's directory, whatever it
    // contains, so the echo is checked rather than ignored.
    if (record.serviceId !== serviceId || typeof known !== 'boolean')
      throw new PeerHelperError('p2p.invalid_server_response')
    if (!isCount(revision) || !isCount(fetchedAt))
      throw new PeerHelperError('p2p.invalid_server_response')
    if (!Array.isArray(networks) || !Array.isArray(devices))
      throw new PeerHelperError('p2p.invalid_server_response')
    return {
      known,
      revision,
      fetchedAt,
      networks: networks.map((network) => peerDirectoryNetwork(network, userId)),
      devices: devices.map((device) => peerNetworkDevice(device, userId))
    }
  } catch {
    throw new PeerHelperError('p2p.invalid_server_response')
  }
}

function peerDirectoryNetwork(value: unknown, userId: string): PeerNetworkDirectory {
  const record = exactPeerObject(value, ['networkId', 'userId', 'name', 'maxDevices', 'devices'])
  if (!Array.isArray(record.devices)) throw new PeerHelperError('p2p.invalid_server_response')
  return {
    ...peerNetwork(
      {
        networkId: record.networkId,
        userId: record.userId,
        name: record.name,
        maxDevices: record.maxDevices
      },
      userId
    ),
    devices: record.devices.map((device) => peerNetworkDevice(device, userId))
  }
}

/** A counter the core could have produced: zero or a positive safe integer. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function peerNetworks(value: unknown, userId: string): PeerNetwork[] {
  if (!Array.isArray(value)) throw new PeerHelperError('p2p.invalid_network_list')
  const networks = value.map((record) => peerNetwork(record, userId))
  if (new Set(networks.map((record) => record.networkId)).size !== networks.length)
    throw new PeerHelperError('p2p.invalid_network_list')
  return networks
}

// Identifiers are twelve lowercase hex characters — the coordinator's shape for
// every id it issues, device ids included, which are derived from the machine key.
export function assertAccountId(value: unknown, length = 12): asserts value is string {
  if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/.test(value))
    throw new PeerHelperError('p2p.invalid_request')
}
export function assertAccountText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 256 ||
    /[\x00\r\n]/.test(value)
  )
    throw new PeerHelperError('p2p.invalid_request')
}

/**
 * Accepts a value a user can sign in with.
 *
 * The coordinator keys every account by email, so a login name is normally an
 * address. Requiring the narrower handle form here refused every real account
 * and made signing in impossible, which is the same mistake peerUser already
 * had to correct. The handle form stays accepted so a coordinator that issues
 * one is not locked out.
 */
export function assertAccountUsername(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new PeerHelperError('p2p.invalid_request')
  const handle = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value)
  const email =
    Buffer.byteLength(value) <= 254 &&
    /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)
  if (!handle && !email) throw new PeerHelperError('p2p.invalid_request')
}

/**
 * Registration identifies the account by email, which assertAccountUsername
 * rejects. This mirrors the coordinator's own pattern and 254-byte ceiling so a
 * value it would refuse is stopped before the password leaves this process.
 */
export function assertAccountEmail(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 254 ||
    !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)
  )
    throw new PeerHelperError('p2p.invalid_request')
}

/**
 * Accepts an account identity as the coordinator reports it.
 *
 * Every account is keyed by email server-side, so a returned identity is
 * normally an address; the narrower handle form is still accepted so a
 * coordinator that reports one is not refused. Control characters and
 * whitespace are rejected either way.
 */
export function assertAccountIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 254)
    throw new PeerHelperError('p2p.invalid_request')
  const handle = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value)
  const address = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)
  if (!handle && !address) throw new PeerHelperError('p2p.invalid_request')
}
