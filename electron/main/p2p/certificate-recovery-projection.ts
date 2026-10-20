import {
  peerNetwork,
  peerNetworkDevice,
  peerUser,
  type PeerNetworkDirectory,
  type PeerUser
} from './account-records'
import { exactPeerObject, PeerHelperError } from './wire'

/** Main-only recovery authorization, never a normal directory cache/snapshot. */
export interface CertificateRecoveryProjection {
  user: PeerUser
  networks: PeerNetworkDirectory[]
}

export function certificateRecoveryProjection(
  value: unknown,
  expectedUser: PeerUser
): CertificateRecoveryProjection {
  let record: Record<string, unknown>
  let user: PeerUser
  try {
    record = exactPeerObject(value, ['user', 'networks'])
    user = peerUser(record.user)
  } catch {
    throw new PeerHelperError('p2p.invalid_server_response')
  }
  if (user.userId !== expectedUser.userId || user.username !== expectedUser.username)
    throw new PeerHelperError('p2p.user_scope_mismatch')
  try {
    if (!Array.isArray(record.networks)) throw new PeerHelperError('p2p.invalid_server_response')
    const networks = record.networks.map((value): PeerNetworkDirectory => {
      const network = exactPeerObject(value, [
        'networkId',
        'userId',
        'name',
        'maxDevices',
        'devices'
      ])
      if (!Array.isArray(network.devices)) throw new PeerHelperError('p2p.invalid_server_response')
      const devices = network.devices.map((device) => peerNetworkDevice(device, user.userId))
      if (new Set(devices.map((device) => device.deviceId)).size !== devices.length)
        throw new PeerHelperError('p2p.invalid_server_response')
      return {
        ...peerNetwork(
          {
            networkId: network.networkId,
            userId: network.userId,
            name: network.name,
            maxDevices: network.maxDevices
          },
          user.userId
        ),
        devices
      }
    })
    if (new Set(networks.map((network) => network.networkId)).size !== networks.length)
      throw new PeerHelperError('p2p.invalid_server_response')
    return { user, networks }
  } catch {
    throw new PeerHelperError('p2p.invalid_server_response')
  }
}
