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
/** Private main memory only. Never return this type from renderer-facing methods. */
export interface PeerUserSession {
  user: PeerUser
  token: string
  expiresAt: number
}

export function peerUser(value: unknown): PeerUser {
  const record = exactPeerObject(value, ['userId', 'username'])
  assertAccountId(record.userId)
  assertAccountUsername(record.username)
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

export function peerNetworks(value: unknown, userId: string): PeerNetwork[] {
  if (!Array.isArray(value)) throw new PeerHelperError('p2p.invalid_network_list')
  const networks = value.map((record) => peerNetwork(record, userId))
  if (new Set(networks.map((record) => record.networkId)).size !== networks.length)
    throw new PeerHelperError('p2p.invalid_network_list')
  return networks
}

export function assertAccountId(value: unknown, length = 32): asserts value is string {
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

export function assertAccountUsername(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value))
    throw new PeerHelperError('p2p.invalid_request')
}
