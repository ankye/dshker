import { createPrivateKey, createPublicKey } from 'node:crypto'
import { assertAccountId, assertAccountText } from './account-records'
import { exactPeerObject, PeerHelperError } from './wire'

/** Durable before consuming a single-use enrollment token; main-only and encrypted. */
export interface PeerPendingEnrollment {
  serviceId: string
  requestId: string
  networkId: string
  userId: string
  name: string
  publicKey: string
  privateKey: string
}

export function assertPendingEnrollment(value: unknown): asserts value is PeerPendingEnrollment {
  const record = exactPeerObject(value, [
    'serviceId',
    'requestId',
    'networkId',
    'userId',
    'name',
    'publicKey',
    'privateKey'
  ])
  assertAccountId(record.serviceId, 64)
  for (const field of ['requestId', 'networkId', 'userId']) assertAccountId(record[field])
  assertAccountText(record.name)
  const publicKey = keyBytes(record.publicKey, 32)
  const privateKey = keyBytes(record.privateKey, 64)
  const seed = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    privateKey.subarray(0, 32)
  ])
  try {
    const native = createPrivateKey({ key: seed, type: 'pkcs8', format: 'der' })
    const derived = createPublicKey(native).export({ type: 'spki', format: 'der' }).subarray(-32)
    if (!derived.equals(publicKey) || !privateKey.subarray(32).equals(publicKey))
      throw new PeerHelperError('p2p.identity_mismatch')
  } finally {
    privateKey.fill(0)
    seed.fill(0)
  }
}

function keyBytes(value: unknown, length: number): Buffer {
  if (typeof value !== 'string') throw new PeerHelperError('p2p.credential_invalid')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== length || bytes.toString('base64') !== value)
    throw new PeerHelperError('p2p.credential_invalid')
  return bytes
}
