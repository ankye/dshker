import { createHash } from 'node:crypto'
import { assertAccountId } from './account-records'
import { PeerHelperError } from './wire'

/**
 * Browser session partitions for remote workbenches.
 *
 * Each paired computer gets a fixed, isolated partition so cookies and tokens
 * from one remote DSH can never be read by another, nor by the Local runtime.
 * The label is derived deterministically from the pinned service and pair
 * identity rather than from a display name, so renaming a computer does not
 * move it into a different partition and two computers cannot collide by
 * sharing a name.
 *
 * Partitions are persistent so a workbench survives a reconnect, and the
 * derivation is one-way: the label reveals neither the service endpoint nor the
 * device keys.
 */

/** The Local runtime keeps its own partition, never shared with any peer. */
export const LOCAL_PARTITION = 'persist:dsh-local' as const

const PREFIX = 'persist:dsh-peer-'

/**
 * Derives the fixed partition label for one paired computer.
 *
 * Both identities are required: a pair id alone is not unique across services,
 * and using the service alone would let two peers share cookies.
 */
export function peerPartition(serviceId: string, pairId: string): string {
  assertAccountId(serviceId, 64)
  assertAccountId(pairId)
  const digest = createHash('sha256').update(`${serviceId}:${pairId}`).digest('hex')
  return `${PREFIX}${digest.slice(0, 32)}`
}

/** True for a label this module produced, used to admit a guest partition. */
export function isPeerPartition(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${PREFIX}[a-f0-9]{32}$`).test(value)
}

/**
 * Admits a partition for an intended pair.
 *
 * A guest may only be attached to the partition its own identity derives to, so
 * a caller cannot pass another computer's label and inherit its session.
 */
export function assertPeerPartition(
  partition: unknown,
  serviceId: string,
  pairId: string
): asserts partition is string {
  if (!isPeerPartition(partition) || partition !== peerPartition(serviceId, pairId))
    throw new PeerHelperError('p2p.partition_mismatch')
}
