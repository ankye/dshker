import {
  P2P_MANAGEMENT_VERSION,
  P2P_NETWORK_DEVICE_LIMITS,
  type P2PManagementOperation,
  type P2PManagementRequest
} from '../../../src/shared/p2p-management'
import { assertAccountId, assertAccountText, assertAccountUsername } from './account-records'
import { assertPeerEndpoints } from './catalog-schema'
import { exactPeerObject, PeerHelperError } from './wire'

const fields: Record<P2PManagementOperation, readonly string[]> = {
  enable: [],
  catalog: [],
  addService: ['revision', 'displayName', 'httpsOrigin', 'wssUrl', 'stunAddress'],
  login: ['serviceId', 'username', 'password'],
  currentUser: ['serviceId'],
  logout: ['serviceId'],
  networks: ['serviceId'],
  createNetwork: ['serviceId', 'name'],
  renameNetwork: ['serviceId', 'networkId', 'name'],
  updateNetworkLimit: ['serviceId', 'networkId', 'maxDevices'],
  deleteNetwork: ['serviceId', 'networkId'],
  registration: ['serviceId'],
  registerDevice: ['serviceId', 'networkId', 'name'],
  joinNetwork: ['serviceId', 'networkId', 'name'],
  submitEnrollment: ['serviceId', 'revision'],
  recoverEnrollment: ['serviceId', 'revision'],
  pairs: ['serviceId'],
  pairIdentity: ['serviceId', 'pairId'],
  createInvite: ['serviceId', 'networkId'],
  acceptInvite: ['serviceId', 'networkId', 'code'],
  approvePair: ['serviceId', 'pairId', 'fingerprint'],
  rejectPair: ['serviceId', 'pairId'],
  revokePair: ['serviceId', 'pairId'],
  connections: [],
  connect: ['serviceId', 'pairId'],
  disconnect: ['serviceId', 'pairId'],
  updateServiceConfig: [
    'serviceId',
    'revision',
    'displayName',
    'httpsOrigin',
    'wssUrl',
    'stunAddress'
  ],
  remoteRoots: ['serviceId', 'pairId'],
  remoteDirectory: ['serviceId', 'pairId', 'rootId', 'ref', 'offset', 'limit'],
  cancel: ['targetRequestId']
}

export function parseManagementRequest<K extends P2PManagementOperation>(
  method: K,
  value: unknown
): P2PManagementRequest<K> {
  const record = exactPeerObject(value, ['version', 'requestId', ...fields[method]])
  if (record.version !== P2P_MANAGEMENT_VERSION) throw new PeerHelperError('p2p.protocol_mismatch')
  assertRequestId(record.requestId)
  for (const field of fields[method]) validateField(field, record[field])
  if (method === 'addService' || method === 'updateServiceConfig') {
    assertPeerEndpoints(
      record.httpsOrigin as string,
      record.wssUrl as string,
      record.stunAddress as string
    )
  }
  // All admitted values are primitives. Copy synchronously before starting any owner.
  return { ...record } as unknown as P2PManagementRequest<K>
}

function validateField(field: string, value: unknown): void {
  if (field === 'targetRequestId') return assertRequestId(value)
  if (field === 'serviceId' || field === 'revision') return assertAccountId(value, 64)
  if (field === 'networkId' || field === 'pairId') return assertAccountId(value)
  if (field === 'name' || field === 'displayName') return assertAccountText(value)
  if (field === 'username') return assertAccountUsername(value)
  if (field === 'offset' || field === 'limit') {
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new PeerHelperError('p2p.invalid_request')
    return
  }
  if (field === 'rootId') {
    if (typeof value !== 'string' || value === '' || value.length > 128)
      throw new PeerHelperError('p2p.invalid_request')
    return
  }
  if (field === 'ref') {
    // Opaque remote reference: bounded and shape-checked, never interpreted here.
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      (value !== '' && !/^[A-Za-z0-9_-]+$/.test(value))
    )
      throw new PeerHelperError('p2p.remote_reference_invalid')
    return
  }
  if (field === 'code') {
    // Bearer invite code: bounded opaque token, never logged or persisted.
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,2048}$/.test(value))
      throw new PeerHelperError('p2p.invite_invalid')
    return
  }
  if (field === 'fingerprint') {
    // Exactly the grouped-hex form the UI displayed, so confirmation is comparable.
    if (typeof value !== 'string' || !/^([a-f0-9]{4} ){7}[a-f0-9]{4}$/.test(value))
      throw new PeerHelperError('p2p.pair_fingerprint_mismatch')
    return
  }
  if (field === 'password') {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 72)
      throw new PeerHelperError('p2p.invalid_request')
    return
  }
  if (field === 'maxDevices') {
    // Only the limits the server accepts for a capacity raise are admitted.
    if (!(P2P_NETWORK_DEVICE_LIMITS as readonly number[]).includes(value as number))
      throw new PeerHelperError('p2p.invalid_network_limit')
    return
  }
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 2048)
    throw new PeerHelperError('p2p.invalid_request')
}

function assertRequestId(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new PeerHelperError('p2p.invalid_request')
}
