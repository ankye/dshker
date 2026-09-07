import { createHash, X509Certificate } from 'node:crypto'
import { exactPeerObject, parsePeerJson, PeerHelperError } from './wire'

export interface PeerServiceRecord {
  serviceId: string
  displayName: string
  httpsOrigin: string
  wssUrl: string
  stunAddress: string
  publicKey: string
  certificate: string
}

export interface PeerComputerRecord {
  connectionId: string
  serviceId: string
  displayName: string
  pairId: string
  networkId: string
  localDeviceId: string
  remoteDeviceId: string
  userId: string
  localPublicKey: string
  remotePublicKey: string
  pairRevision: number
  pairState: 'active' | 'revoked'
}

export interface PeerCatalogRecord {
  format: 'dshker.p2p-devices'
  version: 1
  catalogId: string
  services: PeerServiceRecord[]
  computers: PeerComputerRecord[]
  forgottenServiceIds: string[]
}

export function parsePeerCatalog(text: string): PeerCatalogRecord {
  const record = exactPeerObject(parsePeerJson(text), [
    'format',
    'version',
    'catalogId',
    'services',
    'computers',
    'forgottenServiceIds'
  ])
  if (
    record.format !== 'dshker.p2p-devices' ||
    record.version !== 1 ||
    !id(record.catalogId, 32) ||
    !Array.isArray(record.services) ||
    !Array.isArray(record.computers) ||
    !Array.isArray(record.forgottenServiceIds)
  )
    fail()
  const services = record.services.map(parsePeerService)
  const computers = record.computers.map(computer)
  const forgotten = record.forgottenServiceIds
  if (forgotten.some((value) => !id(value, 64))) fail()
  unique(services.map((value) => value.serviceId))
  unique(computers.map((value) => value.connectionId))
  unique(computers.map((value) => value.serviceId + ':' + value.pairId))
  unique(forgotten)
  const known = new Set(services.map((value) => value.serviceId))
  if (computers.some((value) => !known.has(value.serviceId))) fail()
  return {
    format: 'dshker.p2p-devices',
    version: 1,
    catalogId: record.catalogId,
    services,
    computers,
    forgottenServiceIds: forgotten as string[]
  }
}

export function parsePeerService(value: unknown): PeerServiceRecord {
  const record = exactPeerObject(value, [
    'serviceId',
    'displayName',
    'httpsOrigin',
    'wssUrl',
    'stunAddress',
    'publicKey',
    'certificate'
  ])
  if (
    !id(record.serviceId, 64) ||
    !name(record.displayName) ||
    !key(record.publicKey) ||
    typeof record.certificate !== 'string' ||
    !record.certificate
  )
    fail()
  assertServiceCertificate(record.certificate, record.publicKey)
  if (
    createHash('sha256').update(Buffer.from(record.publicKey, 'base64')).digest('hex') !==
    record.serviceId
  )
    fail()
  if (
    typeof record.httpsOrigin !== 'string' ||
    typeof record.wssUrl !== 'string' ||
    typeof record.stunAddress !== 'string'
  )
    fail()
  assertPeerEndpoints(record.httpsOrigin, record.wssUrl, record.stunAddress)
  return record as unknown as PeerServiceRecord
}

export function assertPeerEndpoints(
  httpsOrigin: string,
  wssUrl: string,
  stunAddress: string
): void {
  try {
    const https = new URL(httpsOrigin)
    const wss = new URL(wssUrl)
    const stun = new URL('udp://' + stunAddress)
    if (
      https.protocol !== 'https:' ||
      https.origin !== httpsOrigin ||
      https.username ||
      https.password ||
      https.search ||
      https.hash ||
      wss.protocol !== 'wss:' ||
      wss.href !== wssUrl ||
      wss.host !== https.host ||
      wss.pathname !== '/v1/signals' ||
      wss.username ||
      wss.password ||
      wss.search ||
      wss.hash ||
      !stun.hostname ||
      !stun.port ||
      Number(stun.port) < 1 ||
      stun.host !== stunAddress ||
      stun.pathname ||
      stun.username ||
      stun.password ||
      stun.search ||
      stun.hash ||
      /\s/.test(stunAddress)
    )
      fail()
  } catch {
    fail()
  }
}

function assertServiceCertificate(encoded: string, publicKey: string): void {
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length || bytes.length > 16 * 1024 || bytes.toString('base64') !== encoded) fail()
    const certificate = new X509Certificate(bytes)
    if (
      !certificate.raw.equals(bytes) ||
      !certificate.ca ||
      certificate.publicKey.asymmetricKeyType !== 'ed25519' ||
      !certificate.verify(certificate.publicKey)
    )
      fail()
    const actual = certificate.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    if (!actual.equals(Buffer.from(publicKey, 'base64'))) fail()
  } catch {
    fail()
  }
}

function computer(value: unknown): PeerComputerRecord {
  const record = exactPeerObject(value, [
    'connectionId',
    'serviceId',
    'displayName',
    'pairId',
    'networkId',
    'localDeviceId',
    'remoteDeviceId',
    'userId',
    'localPublicKey',
    'remotePublicKey',
    'pairRevision',
    'pairState'
  ])
  if (
    !id(record.connectionId, 32) ||
    !id(record.serviceId, 64) ||
    !name(record.displayName) ||
    !id(record.pairId, 32) ||
    !id(record.networkId, 32) ||
    !id(record.localDeviceId, 32) ||
    !id(record.remoteDeviceId, 32) ||
    !id(record.userId, 32) ||
    record.localDeviceId === record.remoteDeviceId ||
    !key(record.localPublicKey) ||
    !key(record.remotePublicKey) ||
    record.localPublicKey === record.remotePublicKey ||
    !Number.isSafeInteger(record.pairRevision) ||
    (record.pairRevision as number) <= 0 ||
    !['active', 'revoked'].includes(record.pairState as string)
  )
    fail()
  return record as unknown as PeerComputerRecord
}

function id(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)
}
function name(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\x00\r\n]/.test(value)
  )
}
function key(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.from(value, 'base64').length === 32 &&
    Buffer.from(value, 'base64').toString('base64') === value
  )
}
function unique(values: unknown[]): void {
  if (new Set(values).size !== values.length) fail()
}
function fail(): never {
  throw new PeerHelperError('p2p.catalog_invalid')
}
