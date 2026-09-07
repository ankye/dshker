import { describe, expect, it } from 'vitest'
import { LOCAL_PARTITION, assertPeerPartition, isPeerPartition, peerPartition } from './partitions'

const serviceA = 'a'.repeat(64)
const serviceB = 'b'.repeat(64)
const pairA = '1'.repeat(32)
const pairB = '2'.repeat(32)

describe('remote workbench session partitions', () => {
  it('gives every paired computer a distinct partition', () => {
    expect(peerPartition(serviceA, pairA)).not.toBe(peerPartition(serviceA, pairB))
  })

  it('does not let two services collide on the same pair id', () => {
    expect(peerPartition(serviceA, pairA)).not.toBe(peerPartition(serviceB, pairA))
  })

  it('keeps the partition stable across calls so a reconnect reuses one session', () => {
    expect(peerPartition(serviceA, pairA)).toBe(peerPartition(serviceA, pairA))
  })

  it('never collides with the Local runtime partition', () => {
    expect(peerPartition(serviceA, pairA)).not.toBe(LOCAL_PARTITION)
  })

  it('is persistent so a workbench survives a reconnect', () => {
    expect(peerPartition(serviceA, pairA).startsWith('persist:')).toBe(true)
  })

  it('leaks neither the service nor the pair identity', () => {
    const label = peerPartition(serviceA, pairA)
    expect(label).not.toContain(serviceA)
    expect(label).not.toContain(pairA)
  })

  it('admits only the partition the intended identity derives to', () => {
    const label = peerPartition(serviceA, pairA)
    expect(() => assertPeerPartition(label, serviceA, pairA)).not.toThrow()
    // Another computer's label must not be accepted for this identity.
    expect(() => assertPeerPartition(peerPartition(serviceA, pairB), serviceA, pairA)).toThrow(
      expect.objectContaining({ code: 'p2p.partition_mismatch' })
    )
  })

  it('refuses the Local partition and arbitrary strings for a peer guest', () => {
    expect(() => assertPeerPartition(LOCAL_PARTITION, serviceA, pairA)).toThrow(
      expect.objectContaining({ code: 'p2p.partition_mismatch' })
    )
    for (const value of ['persist:whatever', '', 'peer', null, 42])
      expect(() => assertPeerPartition(value, serviceA, pairA)).toThrow()
  })

  it('recognises only labels it produced', () => {
    expect(isPeerPartition(peerPartition(serviceA, pairA))).toBe(true)
    expect(isPeerPartition(LOCAL_PARTITION)).toBe(false)
    expect(isPeerPartition('persist:dsh-peer-nothex')).toBe(false)
  })

  it('rejects malformed identities instead of deriving a label', () => {
    expect(() => peerPartition('short', pairA)).toThrow()
    expect(() => peerPartition(serviceA, 'short')).toThrow()
  })
})
