import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertPendingEnrollment } from './enrollment-record'

function pending() {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const seed = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
  return {
    serviceId: 'a'.repeat(64),
    requestId: 'b'.repeat(32),
    networkId: 'c'.repeat(32),
    userId: 'd'.repeat(32),
    name: '远程电脑',
    publicKey: publicKey.toString('base64'),
    privateKey: Buffer.concat([seed, publicKey]).toString('base64')
  }
}

describe('durable pending enrollment identity', () => {
  it('accepts the exact original key and scope without mutating it', () => {
    const record = pending()
    const original = { ...record }
    expect(() => assertPendingEnrollment(record)).not.toThrow()
    expect(record).toEqual(original)
  })
  it.each(['token', 'password', 'certificate', 'deviceId', 'csr'])(
    'rejects unexpected %s',
    (field) => {
      expect(() => assertPendingEnrollment({ ...pending(), [field]: 'not allowed' })).toThrow()
    }
  )
  it.each(['serviceId', 'requestId', 'networkId', 'userId', 'name', 'publicKey', 'privateKey'])(
    'rejects a missing %s',
    (field) => {
      const record: Record<string, unknown> = pending()
      delete record[field]
      expect(() => assertPendingEnrollment(record)).toThrow()
    }
  )
  it('rejects a key suffix mismatch and noncanonical base64', () => {
    const record = pending()
    const corrupted = Buffer.from(record.privateKey, 'base64')
    corrupted[63] ^= 1
    expect(() =>
      assertPendingEnrollment({ ...record, privateKey: corrupted.toString('base64') })
    ).toThrowError('p2p.identity_mismatch')
    expect(() =>
      assertPendingEnrollment({ ...record, publicKey: record.publicKey + '\n' })
    ).toThrow()
  })
})
