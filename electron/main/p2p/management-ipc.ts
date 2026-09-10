import { ipcMain } from 'electron'
import { apiFail, apiOk } from '../../../src/shared/contracts'
import {
  P2P_MANAGEMENT_CHANNELS,
  P2P_MANAGEMENT_ERROR_CODES,
  type P2PManagementErrorCode,
  type P2PManagementOperation,
  type P2PManagementRequest,
  type P2PManagementResults
} from '../../../src/shared/p2p-management'
import { isTrustedRenderer } from '../security'
import type { PeerManagement } from './management'
import { parseManagementRequest } from './management-admission'
import {
  projectPeerCatalog,
  projectPeerUser,
  projectPeerNetwork,
  projectPeerNetworkDevices,
  projectPeerRegistration,
  projectPeerPair,
  projectPeerPairs,
  projectPeerInvite,
  projectPeerConnection,
  projectPeerConnections
} from './management-projection'
import { PeerManagementRequests } from './management-requests'
import { PeerHelperError } from './wire'

/** Owner methods the IPC may dispatch to; every operation is now implemented. */
export type PeerManagementOwner = Pick<PeerManagement, Exclude<P2PManagementOperation, 'cancel'>>

/** No raw RPC dispatch, paths, keys or tokens cross this boundary. */
export function registerPeerManagementIpc(owner: PeerManagementOwner): void {
  const requests = new PeerManagementRequests()
  function register<K extends Exclude<P2PManagementOperation, 'cancel'>>(
    method: K,
    writes: boolean,
    operation: (
      request: P2PManagementRequest<K>,
      signal: AbortSignal
    ) => Promise<P2PManagementResults[K]>
  ) {
    ipcMain.handle(P2P_MANAGEMENT_CHANNELS[method], async (event, payload, ...args) => {
      try {
        if (!isTrustedRenderer(event)) throw new PeerHelperError('p2p.ipc_invalid_sender')
        if (args.length !== 0) throw new PeerHelperError('p2p.invalid_request')
        const request = parseManagementRequest(method, payload)
        return apiOk(
          await requests.run(event, request.requestId, writes, (signal) =>
            operation(request, signal)
          )
        )
      } catch (error) {
        return failure(error)
      }
    })
  }
  register('enable', true, async () => projectPeerCatalog(await owner.enable()))
  register('catalog', false, async () => {
    const saved = await owner.catalog()
    return saved === undefined ? null : projectPeerCatalog(saved)
  })
  register('addService', true, async (r, s) =>
    projectPeerCatalog(
      await owner.addService(
        r.revision,
        {
          displayName: r.displayName,
          httpsOrigin: r.httpsOrigin,
          wssUrl: r.wssUrl,
          stunAddress: r.stunAddress
        },
        s
      )
    )
  )
  register('login', true, async (r, s) =>
    projectPeerUser(await owner.login(r.serviceId, r.username, r.password, s))
  )
  // The helper registers against POST /v1/register and then signs in, so a
  // confirmed result is a real session and the caller is signed in as if by login.
  register('register', true, async (r, s) =>
    projectPeerUser(await owner.register(r.serviceId, r.email, r.password, s))
  )
  register('currentUser', false, async (r, s) =>
    projectPeerUser(await owner.currentUser(r.serviceId, s))
  )
  register('logout', true, (r, s) => owner.logout(r.serviceId, s))
  register('networks', false, async (r, s) =>
    (await owner.networks(r.serviceId, s)).map(projectPeerNetwork)
  )
  register('networkDevices', false, async (r, s) => {
    const { devices, localDeviceId } = await owner.networkDevices(r.serviceId, r.networkId, s)
    return projectPeerNetworkDevices(devices, localDeviceId)
  })
  register('createNetwork', true, async (r, s) =>
    projectPeerNetwork(await owner.createNetwork(r.serviceId, r.name, s))
  )
  register('renameNetwork', true, async (r, s) =>
    projectPeerNetwork(await owner.renameNetwork(r.serviceId, r.networkId, r.name, s))
  )
  register('updateNetworkLimit', true, async (r, s) =>
    projectPeerNetwork(await owner.updateNetworkLimit(r.serviceId, r.networkId, r.maxDevices, s))
  )
  register('deleteNetwork', true, (r, s) => owner.deleteNetwork(r.serviceId, r.networkId, s))
  register('registration', false, async (r, s) =>
    projectPeerRegistration(await owner.registration(r.serviceId, s))
  )
  register('registerDevice', true, async (r, s) =>
    projectPeerRegistration(await owner.registerDevice(r.serviceId, r.networkId, r.name, s))
  )
  // Login-free: holding the networkId is the whole claim, so no session is read.
  register('joinNetwork', true, async (r, s) =>
    projectPeerRegistration(await owner.joinNetwork(r.serviceId, r.networkId, r.name, s))
  )
  // Leaving requires the owner's session: the coordinator has no login-free
  // removal, so without one any holder of a deviceId could evict a device.
  register('leaveNetwork', true, (r, s) =>
    owner.leaveNetwork(r.serviceId, r.networkId, r.deviceId, s)
  )
  register('submitEnrollment', true, async (r, s) =>
    projectPeerRegistration(await owner.submitEnrollment(r.serviceId, r.revision, s))
  )
  register('recoverEnrollment', true, async (r, s) =>
    projectPeerRegistration(await owner.recoverEnrollment(r.serviceId, r.revision, s))
  )
  register('pairs', false, async (r, s) => projectPeerPairs(await owner.pairs(r.serviceId, s)))
  register('pairIdentity', false, async (r, s) =>
    projectPeerPair(await owner.pairIdentity(r.serviceId, r.pairId, s))
  )
  // Minting an invite is a server write even though it returns a secret code.
  register('createInvite', true, async (r, s) =>
    projectPeerInvite(await owner.createInvite(r.serviceId, r.networkId, s))
  )
  register('acceptInvite', true, async (r, s) =>
    projectPeerPair(await owner.acceptInvite(r.serviceId, r.networkId, r.code, s))
  )
  register('approvePair', true, async (r, s) =>
    projectPeerPair(await owner.approvePair(r.serviceId, r.pairId, r.fingerprint, s))
  )
  register('rejectPair', true, async (r, s) =>
    projectPeerPair(await owner.rejectPair(r.serviceId, r.pairId, s))
  )
  register('revokePair', true, async (r, s) =>
    projectPeerCatalog(await owner.revokePair(r.serviceId, r.pairId, s))
  )
  // Removing a configured server rewrites the whole catalog projection.
  register('removeService', true, async (r, s) =>
    projectPeerCatalog(await owner.removeService(r.serviceId, s))
  )
  register('connections', false, async () => projectPeerConnections(owner.connections()))
  // The network layer: this computer's session with each coordinator, which is
  // what presence and pairing depend on. A pair connection is reported above.
  register('serviceSessions', false, async () => owner.serviceSessions())
  // Starting a connection is a write: it consumes an attempt and a generation.
  register('connect', true, async (r, s) =>
    projectPeerConnection(r.serviceId, await owner.connect(r.serviceId, r.pairId, s))
  )
  register('disconnect', true, (r, s) => owner.disconnect(r.serviceId, r.pairId, s))
  register('localDevice', false, async () => owner.localDevice())
  register('updateServiceConfig', true, async (r, s) =>
    projectPeerCatalog(
      await owner.updateServiceConfig(
        r.serviceId,
        r.revision,
        {
          displayName: r.displayName,
          httpsOrigin: r.httpsOrigin,
          wssUrl: r.wssUrl,
          stunAddress: r.stunAddress
        },
        s
      )
    )
  )
  register('remoteRoots', false, (r, s) => owner.remoteRoots(r.serviceId, r.pairId, s))
  register('remoteDirectory', false, (r, s) =>
    owner.remoteDirectory(r.serviceId, r.pairId, r.rootId, r.ref, r.offset, r.limit, s)
  )
  ipcMain.handle(P2P_MANAGEMENT_CHANNELS.cancel, (event, payload, ...args) => {
    try {
      if (!isTrustedRenderer(event)) throw new PeerHelperError('p2p.ipc_invalid_sender')
      if (args.length !== 0) throw new PeerHelperError('p2p.invalid_request')
      const request = parseManagementRequest('cancel', payload)
      return apiOk(requests.cancel(event, request.requestId, request.targetRequestId))
    } catch (error) {
      return failure(error)
    }
  })
}

function failure(error: unknown) {
  const code: P2PManagementErrorCode =
    error instanceof PeerHelperError &&
    (P2P_MANAGEMENT_ERROR_CODES as readonly string[]).includes(error.code)
      ? (error.code as P2PManagementErrorCode)
      : 'p2p.internal_error'
  // Surface an unexpected (non-PeerHelperError, or unknown-code) failure to the
  // main-process console so the real cause is visible instead of a bare
  // internal_error. Only sentinel codes and stack are logged, never secrets.
  if (code === 'p2p.internal_error') {
    if (error instanceof Error) console.error('[p2p] internal_error:', error.message, error.stack)
    else console.error('[p2p] internal_error (non-Error):', String(error))
  }
  return apiFail(code, code)
}
