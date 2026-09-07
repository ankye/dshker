import type { PeerCatalogRecord, PeerComputerRecord } from './catalog-schema'
import { PeerHelperError } from './wire'

const identityFields = [
  'serviceId',
  'pairId',
  'networkId',
  'localDeviceId',
  'remoteDeviceId',
  'userId',
  'localPublicKey',
  'remotePublicKey'
] as const satisfies ReadonlyArray<keyof PeerComputerRecord>

/** Persistence enforces identity continuity even if a main workflow is incorrect. */
export function assertPeerCatalogTransition(
  previous: PeerCatalogRecord,
  next: PeerCatalogRecord
): void {
  const forgotten = new Set(previous.forgottenServiceIds)
  if (previous.forgottenServiceIds.some((id) => !next.forgottenServiceIds.includes(id)))
    reject('p2p.trust_restore_rejected')
  const services = new Map(previous.services.map((value) => [value.serviceId, value]))
  for (const service of next.services) {
    const old = services.get(service.serviceId)
    if (forgotten.has(service.serviceId) && JSON.stringify(old) !== JSON.stringify(service))
      reject('p2p.trust_restore_rejected')
    if (old && old.publicKey !== service.publicKey) reject('p2p.identity_mismatch')
  }
  for (const service of previous.services) {
    if (
      !next.services.some((value) => value.serviceId === service.serviceId) &&
      !forgotten.has(service.serviceId)
    )
      reject('p2p.forget_required')
  }
  const computers = new Map(previous.computers.map((value) => [value.connectionId, value]))
  for (const computer of next.computers) {
    const old = computers.get(computer.connectionId)
    if (forgotten.has(computer.serviceId) && JSON.stringify(old) !== JSON.stringify(computer))
      reject('p2p.trust_restore_rejected')
    if (old) assertComputerTransition(old, computer)
  }
  for (const computer of previous.computers) {
    if (
      !next.computers.some((value) => value.connectionId === computer.connectionId) &&
      computer.pairState !== 'revoked' &&
      !forgotten.has(computer.serviceId)
    )
      reject('p2p.revocation_required')
  }
}

function assertComputerTransition(previous: PeerComputerRecord, next: PeerComputerRecord): void {
  if (identityFields.some((field) => previous[field] !== next[field]))
    reject('p2p.identity_mismatch')
  if (
    next.pairRevision < previous.pairRevision ||
    (previous.pairState === 'revoked' && next.pairState !== 'revoked')
  )
    reject('p2p.trust_restore_rejected')
}

function reject(code: string): never {
  throw new PeerHelperError(code)
}
