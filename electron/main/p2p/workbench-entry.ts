import { assertAccountId } from './account-records'
import type { PeerCatalog } from './catalog'
import { parseHelperState, type PeerHelperState } from './helper-state'
import { peerPartition } from './partitions'
import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

interface EntryOwner {
  rpc: Pick<PeerRpc, 'call'>
  catalog: Pick<PeerCatalog, 'inspect'>
  current(serviceId: string, pairId: string): PeerHelperState | undefined
  /** Refuses when the main session that began this read no longer owns it. */
  admit(): void
}

interface EntryRequest {
  serviceId: string
  pairId: string
  generation: number
}

/** Read-only core authority; no cached address can stand in for this generation. */
export async function readPeerWorkbenchEntry(
  owner: EntryOwner,
  request: EntryRequest,
  signal: AbortSignal
): Promise<{ url: string; partition: string }> {
  const { serviceId, pairId, generation } = request
  assertAccountId(serviceId, 12)
  assertAccountId(pairId)
  if (!Number.isSafeInteger(generation) || generation <= 0)
    throw new PeerHelperError('p2p.invalid_request')
  admit(owner, signal)
  const authority = await authorize(owner, request, signal)
  const before = currentReady(owner, request)
  const reply = exactPeerObject(
    await owner.rpc.call('peer.entry', { serviceId, data: { pairId, generation } }, signal),
    ['serviceId', 'state', 'url']
  )
  admit(owner, signal)
  if (reply.serviceId !== serviceId) throw new PeerHelperError('p2p.identity_mismatch')
  const state = parseHelperState(reply.state)
  assertSameReady(state, before)
  const url = loopbackEntry(reply.url)
  const readbackAuthority = await authorize(owner, request, signal)
  if (readbackAuthority !== authority) throw new PeerHelperError('p2p.stale_generation')
  assertSameReady(currentReady(owner, request), before)
  return { url, partition: peerPartition(serviceId, pairId) }
}

function admit(owner: EntryOwner, signal: AbortSignal): void {
  owner.admit()
  if (!signal.aborted) return
  if (signal.reason instanceof PeerHelperError) throw signal.reason
  throw new PeerHelperError('p2p.request_cancelled')
}

/** Compare the identity/pins, not unrelated catalog changes or display names. */
async function authorize(
  owner: EntryOwner,
  request: EntryRequest,
  signal: AbortSignal
): Promise<string> {
  const saved = await owner.catalog.inspect()
  admit(owner, signal)
  if (!saved) throw new PeerHelperError('p2p.not_enabled')
  const { serviceId, pairId } = request
  const { record } = saved
  if (record.forgottenServiceIds.includes(serviceId))
    throw new PeerHelperError('p2p.trust_restore_rejected')
  const service = record.services.find((value) => value.serviceId === serviceId)
  if (!service) throw new PeerHelperError('p2p.service_not_found')
  const computer = record.computers.find(
    (value) => value.serviceId === serviceId && value.pairId === pairId
  )
  if (computer?.pairState !== 'active') throw new PeerHelperError('p2p.pair_unauthorized')
  const { displayName: _serviceName, ...serviceIdentity } = service
  const { displayName: _computerName, ...computerIdentity } = computer
  return JSON.stringify([serviceIdentity, computerIdentity])
}

function currentReady(owner: EntryOwner, request: EntryRequest): PeerHelperState {
  const state = owner.current(request.serviceId, request.pairId)
  if (!state) throw new PeerHelperError('p2p.connection_not_found')
  if (state.pairId !== request.pairId) throw new PeerHelperError('p2p.identity_mismatch')
  if (state.generation !== request.generation) throw new PeerHelperError('p2p.stale_generation')
  if (state.stage !== 'ready') throw new PeerHelperError('p2p.not_connected')
  return state
}

function assertSameReady(state: PeerHelperState, expected: PeerHelperState): void {
  if (state.pairId !== expected.pairId) throw new PeerHelperError('p2p.identity_mismatch')
  if (state.stage !== 'ready') throw new PeerHelperError('p2p.not_connected')
  if (
    state.generation !== expected.generation ||
    state.attemptId !== expected.attemptId ||
    state.runtimeGeneration !== expected.runtimeGeneration
  )
    throw new PeerHelperError('p2p.stale_generation')
}

function loopbackEntry(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new PeerHelperError('p2p.invalid_socket')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new PeerHelperError('p2p.invalid_socket')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== ''
  )
    throw new PeerHelperError('p2p.invalid_socket')
  return value
}
