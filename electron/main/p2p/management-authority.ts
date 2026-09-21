import type { PeerCatalog } from './catalog'
import type { PeerConnections } from './connections'
import type { PeerRuntimeHost, PeerChannel } from './runtime-host'
import { exactPeerObject, PeerHelperError } from './wire'

/** Revocation cleanup is authoritative even when later local persistence fails. */
export async function removeNetworkAuthority(options: {
  rpc: PeerChannel
  catalog: PeerCatalog
  host: PeerRuntimeHost
  lifetime: AbortSignal
  connections: PeerConnections | undefined
  serviceId: string
  networkId: string
}): Promise<void> {
  const { rpc, catalog, host, lifetime, connections, serviceId, networkId } = options
  // Server deletion has already committed. User cancellation must not cancel cleanup.
  try {
    exactPeerObject(
      await rpc.call('network.invalidate', { serviceId, data: { networkId } }, lifetime),
      []
    )
  } catch (error) {
    await host.failClosed(new PeerHelperError('p2p.authorization_cleanup_failed'))
    throw error
  }
  const saved = await catalog.inspect()
  if (!saved) throw new PeerHelperError('p2p.not_enabled')
  const computers = saved.record.computers.map((computer) =>
    computer.serviceId === serviceId && computer.networkId === networkId
      ? { ...computer, pairState: 'revoked' as const }
      : computer
  )
  // Authorization for this network is gone; drop its local entry points too.
  for (const computer of saved.record.computers)
    if (computer.serviceId === serviceId && computer.networkId === networkId)
      connections?.invalidate(serviceId, computer.pairId)
  // Persistence failure does not undo server revocation or restore helper pins.
  await catalog.commit(saved.revision, { ...saved.record, computers })
}

/** A revoked pair cannot be projected as active even if the catalog readback fails. */
export async function removePairAuthority(
  catalog: PeerCatalog,
  serviceId: string,
  pairId: string
): Promise<void> {
  const saved = await catalog.inspect()
  if (!saved) throw new PeerHelperError('p2p.not_enabled')
  const computers = saved.record.computers.map((computer) =>
    computer.serviceId === serviceId && computer.pairId === pairId
      ? { ...computer, pairState: 'revoked' as const }
      : computer
  )
  await catalog.commit(saved.revision, { ...saved.record, computers })
}
