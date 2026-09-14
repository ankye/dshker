import type { PeerCatalog } from './catalog'
import type { PeerPairMember, PeerPairMemberDevice } from './pair-records'
import { PeerHelperError } from './wire'

/** What this machine's own identity looks like to the catalog rewrite. */
export interface MemberCredential {
  readonly deviceId: string
  readonly userId: string
  readonly publicKey: string
}

/** The peer side of a pair, or undefined when this device is not one of its ends. */
export function remoteSide(
  member: PeerPairMember,
  localDeviceId: string
): PeerPairMemberDevice | undefined {
  if (member.initiator.deviceId === localDeviceId) return member.target
  if (member.target.deviceId === localDeviceId) return member.initiator
  return undefined
}

/** Compares two base64 public keys by their bytes rather than their encoding. */
function samePublicKey(left: string, right: string): boolean {
  return Buffer.from(left, 'base64').equals(Buffer.from(right, 'base64'))
}

/**
 * Persists the current pairs as computer records so tabs and lists survive restarts.
 *
 * Only the coordinator's active pairs are admitted, and a record naming this
 * machine as its own peer is dropped wherever it appears: an older build could
 * write one, and it would otherwise survive every rewrite because it belongs to
 * the service being rewritten.
 *
 * A row of this service the coordinator's list no longer carries is marked
 * revoked rather than dropped. Dropping an active pair is exactly what the
 * catalog's transition guard exists to refuse — a silent loss — so the drop
 * used to fail the whole commit and wedge every later sync on
 * p2p.revocation_required (both machines re-enrolling left each side stuck on
 * the other's old identity). The server's omission is itself the evidence the
 * authorization is gone, so recording it as a revocation converges the catalog
 * while keeping the loss visible. A revoked row is not carried into later
 * rewrites, so it disappears on the next sync instead of accumulating.
 */
export async function recordMembers(
  catalog: PeerCatalog,
  serviceId: string,
  credential: MemberCredential,
  members: readonly PeerPairMember[]
): Promise<void> {
  const saved = await catalog.inspect()
  if (!saved) throw new PeerHelperError('p2p.not_enabled')
  const computers = saved.record.computers.filter(
    (computer) =>
      computer.serviceId !== serviceId && computer.remoteDeviceId !== credential.deviceId
  )
  const recorded = new Set(computers.map((computer) => computer.connectionId))
  for (const member of members) {
    // The catalog only admits a positive revision and an active pair.
    if (member.state !== 'active' || member.revision <= 0) continue
    const remote = remoteSide(member, credential.deviceId)
    if (remote === undefined) continue
    const local = remote === member.initiator ? member.target : member.initiator
    if (local.deviceId !== credential.deviceId) continue
    if (!samePublicKey(local.publicKey, credential.publicKey)) continue
    if (remote.deviceId === local.deviceId) continue
    // One fixed tab per computer: a second pair with the same peer (over
    // another network) must not create a duplicate connection id.
    if (recorded.has(remote.deviceId)) continue
    recorded.add(remote.deviceId)
    computers.push({
      connectionId: remote.deviceId,
      serviceId,
      displayName: remote.name.length > 0 ? remote.name : remote.deviceId,
      // The coordinator keys a connection attempt by the TARGET DEVICE ID and the
      // lease reports it back the same way, so the id every consumer (peer.connect,
      // the connection stage lookup) must use is the device id, not the pairs-table
      // row id.
      pairId: remote.deviceId,
      networkId: member.networkId,
      localDeviceId: local.deviceId,
      remoteDeviceId: remote.deviceId,
      userId: local.userId,
      localPublicKey: local.publicKey,
      remotePublicKey: remote.publicKey,
      pairRevision: member.revision,
      pairState: 'active'
    })
  }
  for (const computer of saved.record.computers) {
    if (computer.serviceId !== serviceId || computer.remoteDeviceId === credential.deviceId)
      continue
    if (computer.pairState === 'revoked' || recorded.has(computer.connectionId)) continue
    computers.push({ ...computer, pairState: 'revoked' })
  }
  await catalog.commit(saved.revision, { ...saved.record, computers })
}
