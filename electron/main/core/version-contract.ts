import { exactPeerObject, PeerHelperError } from '../p2p/wire'

/** Frame version 1; state/payload contract 2 includes suspended v2 attempts. */
export function assertCoreVersion(value: unknown): void {
  const version = exactPeerObject(value, ['version', 'methodTableVersion', 'methods'])
  if (version.version !== 1 || version.methodTableVersion !== 2 || !Array.isArray(version.methods))
    throw new PeerHelperError('p2p.protocol_mismatch')
}
