import { assertAccountId } from './account-records'
import { exactPeerObject, peerErrorCode, PeerHelperError } from './wire'

export interface PeerHelperState {
  pairId: string
  attemptId: string
  generation: number
  stage:
    | 'punching'
    | 'starting-runtime'
    | 'connected'
    | 'ready'
    | 'suspended'
    | 'failed'
    | 'disconnected'
  error: string
  path: { localType: string; remoteType: string; protocol: string }
  runtimeGeneration: number
}

/** This projection intentionally cannot contain a DSH URL, cookie or token. */
export function parseHelperState(value: unknown): PeerHelperState {
  const record = exactPeerObject(value, [
    'pairId',
    'attemptId',
    'generation',
    'stage',
    'error',
    'path',
    'runtimeGeneration'
  ])
  assertAccountId(record.pairId)
  // v1 explicit connections use 12hex; control-v2 attempts use 128-bit 32hex.
  // Neither format widens admission for device/network/pair identifiers.
  assertAccountId(
    record.attemptId,
    typeof record.attemptId === 'string' && record.attemptId.length === 32 ? 32 : 12
  )
  const path = exactPeerObject(record.path, ['localType', 'remoteType', 'protocol'])
  const emptyPath = path.localType === '' && path.remoteType === '' && path.protocol === ''
  const directPath =
    ['host', 'srflx', 'prflx'].includes(path.localType as string) &&
    ['host', 'srflx', 'prflx'].includes(path.remoteType as string) &&
    path.protocol === 'udp'
  if (
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0 ||
    !Number.isSafeInteger(record.runtimeGeneration) ||
    (record.runtimeGeneration as number) < 0 ||
    ![
      'punching',
      'starting-runtime',
      'connected',
      'ready',
      'suspended',
      'failed',
      'disconnected'
    ].includes(record.stage as string) ||
    typeof record.error !== 'string' ||
    (record.error !== '' && !peerErrorCode(record.error)) ||
    (!emptyPath && !directPath)
  )
    throw new PeerHelperError('p2p.invalid_peer_state')
  if (record.stage === 'connected' && (!directPath || record.runtimeGeneration !== 0))
    throw new PeerHelperError('p2p.invalid_peer_state')
  if (
    record.stage === 'ready' &&
    (!directPath || record.runtimeGeneration === 0 || record.error !== '')
  )
    throw new PeerHelperError('p2p.invalid_peer_state')
  if (record.stage === 'failed' && record.error === '')
    throw new PeerHelperError('p2p.invalid_peer_state')
  if (record.stage === 'suspended' && (!directPath || record.error !== ''))
    throw new PeerHelperError('p2p.invalid_peer_state')
  return { ...record, path: { ...path } } as unknown as PeerHelperState
}

export function assertStateProgress(previous: PeerHelperState, next: PeerHelperState): void {
  // A generation counts attempts within one launcher process, so a peer that
  // restarts begins again from one: comparing generations across attempts named
  // every attempt a restarted peer made "stale", the stage never recorded, and
  // every runtime request after that was refused as p2p.runtime_request_unscoped.
  // Inside one attempt the generation never changes, so ordering is enforced
  // there — the ranks are the replay guard — while a different attempt is a new
  // lineage whose freshness the caller decides by whether it has seen it before.
  if (next.attemptId !== previous.attemptId) return
  if (next.generation !== previous.generation) throw new PeerHelperError('p2p.stale_generation')
  // Suspension is a reversible state of this exact carrier, not a new attempt
  // and not permission to revive a terminal one. Preserve its runtime authority.
  if (next.stage === 'suspended' || previous.stage === 'suspended') {
    const allowed =
      (['connected', 'ready', 'suspended'].includes(previous.stage) &&
        next.stage === 'suspended' &&
        previous.runtimeGeneration === next.runtimeGeneration) ||
      (previous.stage === 'suspended' &&
        ((next.stage === 'connected' && previous.runtimeGeneration === 0) ||
          (next.stage === 'ready' && previous.runtimeGeneration > 0)) &&
        previous.runtimeGeneration === next.runtimeGeneration) ||
      (previous.stage === 'suspended' && (next.stage === 'failed' || next.stage === 'disconnected'))
    if (!allowed) throw new PeerHelperError('p2p.stale_generation')
    return
  }
  const ranks = {
    punching: 0,
    'starting-runtime': 1,
    connected: 2,
    ready: 3,
    suspended: 3,
    failed: 4,
    disconnected: 4
  }
  if (
    ranks[next.stage] < ranks[previous.stage] ||
    (previous.stage === 'failed' && next.stage !== 'failed')
  )
    throw new PeerHelperError('p2p.stale_generation')
}
