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
  type Computer = (typeof saved.record.computers)[number]
  const kept = saved.record.computers.filter(
    (computer) =>
      computer.serviceId !== serviceId && computer.remoteDeviceId !== credential.deviceId
  )
  const recorded = new Set(kept.map((computer) => computer.connectionId))
  const fresh: Computer[] = []
  const freshIds = new Set<string>()
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
    if (recorded.has(remote.deviceId) || freshIds.has(remote.deviceId)) continue
    freshIds.add(remote.deviceId)
    fresh.push({
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
  // Rows of this service the coordinator no longer carries are recorded as
  // revoked rather than dropped, because dropping an active computer is what the
  // catalog's guard refuses; an already revoked row is simply not carried
  // forward, so it disappears on the next rewrite instead of accumulating.
  const carried = saved.record.computers
    .filter(
      (computer) =>
        computer.serviceId === serviceId &&
        computer.remoteDeviceId !== credential.deviceId &&
        computer.pairState !== 'revoked' &&
        !freshIds.has(computer.connectionId)
    )
    .map((computer) => ({ ...computer, pairState: 'revoked' as const }))
  // A connection whose authorization the coordinator has issued again — the same
  // two devices re-paired, or a network rejoined — cannot be revived in the same
  // commit that replaces its revoked row: the catalog refuses to take a revoked
  // computer back to active at all, and a fresh pairing numbers its revision from
  // the start, so a newer revision is not something to rely on. Retiring the
  // revoked row is its own legal step (dropping a revoked computer is exactly
  // what retirement means), so it is committed first and the new authorization is
  // recorded against the revision that commit produced.
  const retired = saved.record.computers.filter(
    (computer) =>
      computer.serviceId === serviceId &&
      computer.pairState === 'revoked' &&
      freshIds.has(computer.connectionId)
  )
  let revision = saved.revision
  if (retired.length > 0) {
    const committed = await catalog.commit(revision, {
      ...saved.record,
      computers: saved.record.computers.filter((computer) => !retired.includes(computer))
    })
    revision = committed.revision
  }
  await catalog.commit(revision, { ...saved.record, computers: [...kept, ...fresh, ...carried] })
}
