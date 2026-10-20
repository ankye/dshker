import type { P2PNetworkChoicesView, P2PManagementInputs } from '../../../src/shared/p2p-management'
import { assertAccountId, assertAccountText } from './account-records'
import type { PeerRpc } from './rpc'
import { exactPeerObject, PeerHelperError } from './wire'

/** An explicit allowlist, not a projection of cached PairIdentity material. */
export function parseNetworkChoices(value: unknown): P2PNetworkChoicesView {
  const root = exactPeerObject(value, ['userId', 'catalogRevision', 'devices'])
  assertAccountId(root.userId)
  assertAccountId(root.catalogRevision, 64)
  if (!Array.isArray(root.devices)) throw new PeerHelperError('p2p.protocol_mismatch')
  const seen = new Set<string>()
  const devices = root.devices.map((value) => {
    const row = exactPeerObject(value, ['pairId', 'name', 'selectedNetworkId', 'state', 'choices'])
    assertAccountId(row.pairId)
    assertAccountText(row.name)
    if (seen.has(row.pairId as string) || !Array.isArray(row.choices))
      throw new PeerHelperError('p2p.protocol_mismatch')
    seen.add(row.pairId as string)
    const networks = new Set<string>()
    const choices = row.choices.map((value) => {
      const choice = exactPeerObject(value, ['networkId', 'name'])
      assertAccountId(choice.networkId)
      assertAccountText(choice.name)
      if (networks.has(choice.networkId as string))
        throw new PeerHelperError('p2p.protocol_mismatch')
      networks.add(choice.networkId as string)
      return { networkId: choice.networkId as string, name: choice.name as string }
    })
    if (row.selectedNetworkId !== '') assertAccountId(row.selectedNetworkId)
    if (
      !['selected', 'required', 'stale'].includes(row.state as string) ||
      (row.state === 'required' && (row.selectedNetworkId !== '' || choices.length === 0)) ||
      (row.state === 'selected' && !networks.has(row.selectedNetworkId as string)) ||
      (row.state === 'stale' && row.selectedNetworkId === '')
    )
      throw new PeerHelperError('p2p.protocol_mismatch')
    return {
      pairId: row.pairId as string,
      name: row.name as string,
      selectedNetworkId: row.selectedNetworkId as string,
      state: row.state as 'selected' | 'required' | 'stale',
      choices
    }
  })
  return { userId: root.userId as string, catalogRevision: root.catalogRevision as string, devices }
}

export async function readNetworkChoices(
  rpc: Pick<PeerRpc, 'call'>,
  serviceId: string,
  signal: AbortSignal
): Promise<P2PNetworkChoicesView> {
  assertAccountId(serviceId)
  return parseNetworkChoices(
    await rpc.call('pairs.network_choices', { serviceId, data: {} }, signal)
  )
}

export async function selectComputerNetwork(
  rpc: Pick<PeerRpc, 'call'>,
  request: P2PManagementInputs['selectNetwork'],
  signal: AbortSignal
): Promise<P2PNetworkChoicesView> {
  const { serviceId, pairId, networkId, userId, expectedRevision } = request
  for (const id of [serviceId, pairId, networkId, userId]) assertAccountId(id)
  assertAccountId(expectedRevision, 64)
  const result = parseNetworkChoices(
    await rpc.call(
      'pairs.select_network',
      {
        serviceId,
        data: { pairId, networkId, userId, expectedRevision }
      },
      signal
    )
  )
  const selected = result.devices.find((device) => device.pairId === pairId)
  if (
    result.userId !== userId ||
    selected?.state !== 'selected' ||
    selected.selectedNetworkId !== networkId
  )
    throw new PeerHelperError('p2p.protocol_mismatch')
  return result
}
