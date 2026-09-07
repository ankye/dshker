import type {
  P2PCatalogView,
  P2PUserView,
  P2PNetworkView,
  P2PRegistrationView,
  P2PPairView,
  P2PInviteView,
  P2PConnectionView
} from '../../../src/shared/p2p-management'
import type { PeerCatalogSnapshot } from './catalog'
import type { PeerHelperState } from './helper-state'
import type { PeerPair, PeerInvite } from './pair-records'
import { PeerHelperError } from './wire'

export function projectPeerUser(value: P2PUserView): P2PUserView {
  return { userId: value.userId, username: value.username }
}
export function projectPeerNetwork(value: P2PNetworkView): P2PNetworkView {
  return { networkId: value.networkId, userId: value.userId, name: value.name }
}
export function projectPeerRegistration(value: P2PRegistrationView): P2PRegistrationView {
  const identity = {
    serviceId: value.serviceId,
    userId: value.userId,
    name: value.name,
    publicKey: value.publicKey,
    revision: value.revision
  }
  if (value.kind === 'pending')
    return { ...identity, kind: 'pending', requestId: value.requestId, networkId: value.networkId }
  if (value.kind !== 'registered') throw new PeerHelperError('p2p.enrollment_state_mismatch')
  return { ...identity, kind: 'registered', deviceId: value.deviceId }
}

/** Explicit allowlist: never spread persistence records into renderer state. */
export function projectPeerCatalog(snapshot: PeerCatalogSnapshot): P2PCatalogView {
  return {
    revision: snapshot.revision,
    catalogId: snapshot.record.catalogId,
    services: snapshot.record.services.map((service) => ({
      serviceId: service.serviceId,
      displayName: service.displayName,
      httpsOrigin: service.httpsOrigin,
      wssUrl: service.wssUrl,
      stunAddress: service.stunAddress,
      publicKey: service.publicKey
    })),
    computers: snapshot.record.computers.map((computer) => ({
      connectionId: computer.connectionId,
      serviceId: computer.serviceId,
      displayName: computer.displayName,
      pairId: computer.pairId,
      networkId: computer.networkId,
      localDeviceId: computer.localDeviceId,
      remoteDeviceId: computer.remoteDeviceId,
      userId: computer.userId,
      localPublicKey: computer.localPublicKey,
      remotePublicKey: computer.remotePublicKey,
      pairRevision: computer.pairRevision,
      pairState: computer.pairState
    })),
    forgottenServiceIds: [...snapshot.record.forgottenServiceIds]
  }
}

/**
 * Projects one pair for the renderer.
 *
 * Only the derived fingerprint crosses the boundary, never the raw public key,
 * and presence stays advisory so the renderer cannot mistake it for a live
 * connection.
 */
export function projectPeerPair(value: PeerPair): P2PPairView {
  const device = (side: PeerPair['initiator']) => ({
    deviceId: side.deviceId,
    userId: side.userId,
    name: side.name,
    fingerprint: side.fingerprint,
    presence: side.presence
  })
  return {
    pairId: value.pairId,
    networkId: value.networkId,
    state: value.state,
    revision: value.revision,
    expiresAt: value.expiresAt,
    initiator: device(value.initiator),
    target: device(value.target),
    localIsInitiator: value.localIsInitiator
  }
}

export function projectPeerPairs(values: readonly PeerPair[]): P2PPairView[] {
  return values.map(projectPeerPair)
}

/**
 * Projects a freshly minted invite.
 *
 * The code is a bearer secret returned exactly once for out-of-band transfer;
 * it is never persisted, so this is the only point it is visible.
 */
export function projectPeerInvite(value: PeerInvite): P2PInviteView {
  return { code: value.code, networkId: value.networkId, expiresAt: value.expiresAt }
}

/**
 * Projects one live connection stage.
 *
 * Built field by field from an allowlist precisely so the main-only local DSH
 * URL cannot ride along, even if the source state is later extended.
 */
export function projectPeerConnection(
  serviceId: string,
  state: PeerHelperState
): P2PConnectionView {
  return {
    serviceId,
    pairId: state.pairId,
    attemptId: state.attemptId,
    generation: state.generation,
    stage: state.stage,
    error: state.error,
    path: {
      localType: state.path.localType,
      remoteType: state.path.remoteType,
      protocol: state.path.protocol
    },
    runtimeGeneration: state.runtimeGeneration
  }
}

export function projectPeerConnections(snapshot: {
  error: string
  peers: { serviceId: string; state: PeerHelperState }[]
}): { error: string; peers: P2PConnectionView[] } {
  return {
    error: snapshot.error,
    peers: snapshot.peers.map((peer) => projectPeerConnection(peer.serviceId, peer.state))
  }
}
