import type { ApiResult } from './contracts'

/** Separate from the helper protocol: these are the only page management capabilities. */
export const P2P_MANAGEMENT_VERSION = 1 as const
export const P2P_MANAGEMENT_CHANNELS = {
  enable: 'dsh-launcher:p2p:enable',
  catalog: 'dsh-launcher:p2p:catalog',
  addService: 'dsh-launcher:p2p:add-service',
  login: 'dsh-launcher:p2p:login',
  currentUser: 'dsh-launcher:p2p:current-user',
  logout: 'dsh-launcher:p2p:logout',
  networks: 'dsh-launcher:p2p:networks',
  createNetwork: 'dsh-launcher:p2p:create-network',
  renameNetwork: 'dsh-launcher:p2p:rename-network',
  deleteNetwork: 'dsh-launcher:p2p:delete-network',
  registration: 'dsh-launcher:p2p:registration',
  registerDevice: 'dsh-launcher:p2p:register-device',
  submitEnrollment: 'dsh-launcher:p2p:submit-enrollment',
  recoverEnrollment: 'dsh-launcher:p2p:recover-enrollment',
  pairs: 'dsh-launcher:p2p:pairs',
  pairIdentity: 'dsh-launcher:p2p:pair-identity',
  createInvite: 'dsh-launcher:p2p:create-invite',
  acceptInvite: 'dsh-launcher:p2p:accept-invite',
  approvePair: 'dsh-launcher:p2p:approve-pair',
  rejectPair: 'dsh-launcher:p2p:reject-pair',
  revokePair: 'dsh-launcher:p2p:revoke-pair',
  connections: 'dsh-launcher:p2p:connections',
  updateServiceConfig: 'dsh-launcher:p2p:update-service-config',
  remoteRoots: 'dsh-launcher:p2p:remote-roots',
  remoteDirectory: 'dsh-launcher:p2p:remote-directory',
  connect: 'dsh-launcher:p2p:connect',
  disconnect: 'dsh-launcher:p2p:disconnect',
  cancel: 'dsh-launcher:p2p:cancel'
} as const

export interface P2PServiceInput {
  displayName: string
  httpsOrigin: string
  wssUrl: string
  stunAddress: string
}
export interface P2PUserView {
  userId: string
  username: string
}
export interface P2PNetworkView {
  networkId: string
  userId: string
  name: string
}
export interface P2PComputerView {
  connectionId: string
  serviceId: string
  displayName: string
  pairId: string
  networkId: string
  localDeviceId: string
  remoteDeviceId: string
  userId: string
  localPublicKey: string
  remotePublicKey: string
  pairRevision: number
  pairState: 'active' | 'revoked'
}
/** One saved service as the renderer sees it: public endpoints and identity only. */
export type P2PServiceView = P2PServiceInput & { serviceId: string; publicKey: string }

export interface P2PCatalogView {
  revision: string
  catalogId: string
  services: P2PServiceView[]
  computers: P2PComputerView[]
  forgottenServiceIds: string[]
}
export type P2PRegistrationView = {
  serviceId: string
  userId: string
  name: string
  publicKey: string
  revision: string
} & (
  | { kind: 'pending'; requestId: string; networkId: string }
  | { kind: 'registered'; deviceId: string }
)

/**
 * One side of a pair, as shown to the user.
 *
 * `presence` is reported by the coordinator and is only ever advisory: a stale
 * heartbeat must read as offline rather than as a usable connection, so the
 * renderer never treats presence as connection state.
 */
export interface P2PPairDeviceView {
  deviceId: string
  userId: string
  name: string
  /** Hex SHA-256 of the device public key; never the key itself. */
  fingerprint: string
  presence: 'online' | 'offline'
}

/**
 * A pairing relationship in its authoritative server state.
 *
 * `pending_target_approval` means this device must approve; `pending_initiator_confirmation`
 * means this device must confirm the remote fingerprint before the pair is usable.
 * Both are distinct from `active`, so no UI can present an unapproved pair as ready.
 */
export interface P2PPairView {
  pairId: string
  networkId: string
  state:
    | 'pending_target_approval'
    | 'pending_initiator_confirmation'
    | 'active'
    | 'revoked'
    | 'expired'
  revision: number
  expiresAt: number
  initiator: P2PPairDeviceView
  target: P2PPairDeviceView
  /** True when this device is the initiator, which decides the available action. */
  localIsInitiator: boolean
}

/**
 * A freshly minted invite. The code is a bearer secret: it is returned exactly
 * once for the user to transfer out of band and is never persisted in the
 * catalog or re-readable through a projection.
 */
export interface P2PInviteView {
  code: string
  networkId: string
  expiresAt: number
}

/**
 * Live connection stage for one paired computer.
 *
 * This projection deliberately cannot carry a DSH URL, cookie or token: the
 * local entry point stays in main and is handed only to the restricted Run
 * guest. `ready` is the sole stage that means the workbench is usable, and it
 * is reported only when a real direct path and runtime generation exist.
 */
/**
 * One directory the remote user authorized.
 *
 * `path` is display-only: it is shown so the user can recognise what they
 * granted, and is never used by this side to build a request. Navigation always
 * travels through opaque references issued by the remote computer.
 */
export interface P2PRemoteRootView {
  rootId: string
  name: string
  path: string
}

/**
 * One directory child inside an authorized root.
 *
 * `ref` is opaque and meaningful only to the remote computer: this side cannot
 * parse or construct one, so it cannot widen the granted scope or reach a path
 * the remote user did not authorize.
 */
export interface P2PRemoteEntryView {
  ref: string
  name: string
  isDirectory: boolean
  isProject: boolean
}

export interface P2PConnectionView {
  serviceId: string
  pairId: string
  attemptId: string
  generation: number
  stage: 'punching' | 'starting-runtime' | 'ready' | 'failed' | 'disconnected'
  /** Error code only, empty unless the stage is `failed`. */
  error: string
  /** ICE candidate kinds, proving the path is direct rather than relayed. */
  path: { localType: string; remoteType: string; protocol: string }
  runtimeGeneration: number
}

interface ServiceRequest {
  serviceId: string
}
interface NetworkRequest extends ServiceRequest {
  networkId: string
}
interface RevisionRequest extends ServiceRequest {
  revision: string
}
export interface P2PManagementInputs {
  enable: Record<never, never>
  catalog: Record<never, never>
  addService: P2PServiceInput & { revision: string }
  login: ServiceRequest & { username: string; password: string }
  currentUser: ServiceRequest
  logout: ServiceRequest
  networks: ServiceRequest
  createNetwork: ServiceRequest & { name: string }
  renameNetwork: NetworkRequest & { name: string }
  deleteNetwork: NetworkRequest
  registration: ServiceRequest
  registerDevice: NetworkRequest & { name: string }
  submitEnrollment: RevisionRequest
  recoverEnrollment: RevisionRequest
  pairs: ServiceRequest
  pairIdentity: ServiceRequest & { pairId: string }
  createInvite: NetworkRequest
  acceptInvite: NetworkRequest & { code: string }
  /**
   * `fingerprint` is the value the user actually saw and confirmed. The server
   * compares it against the real remote key, so a mismatch fails instead of
   * silently authorizing an unknown device.
   */
  approvePair: ServiceRequest & { pairId: string; fingerprint: string }
  rejectPair: ServiceRequest & { pairId: string }
  revokePair: ServiceRequest & { pairId: string }
  connections: Record<never, never>
  updateServiceConfig: ServiceRequest & {
    revision: string
    displayName: string
    httpsOrigin: string
    wssUrl: string
    stunAddress: string
  }
  remoteRoots: ServiceRequest & { pairId: string }
  remoteDirectory: ServiceRequest & {
    pairId: string
    rootId: string
    /** Empty means the root itself; otherwise a reference the remote issued. */
    ref: string
    offset: number
    limit: number
  }
  connect: ServiceRequest & { pairId: string }
  disconnect: ServiceRequest & { pairId: string }
  cancel: { targetRequestId: number }
}
export interface P2PManagementResults {
  enable: P2PCatalogView
  catalog: P2PCatalogView | null
  addService: P2PCatalogView
  login: P2PUserView
  currentUser: P2PUserView
  logout: void
  networks: P2PNetworkView[]
  createNetwork: P2PNetworkView
  renameNetwork: P2PNetworkView
  deleteNetwork: void
  registration: P2PRegistrationView
  registerDevice: P2PRegistrationView
  submitEnrollment: P2PRegistrationView
  recoverEnrollment: P2PRegistrationView
  pairs: P2PPairView[]
  pairIdentity: P2PPairView
  createInvite: P2PInviteView
  acceptInvite: P2PPairView
  approvePair: P2PPairView
  rejectPair: P2PPairView
  revokePair: P2PCatalogView
  /** Live stages plus the last helper-level error, both read-only. */
  connections: { error: string; peers: P2PConnectionView[] }
  /** The whole catalog, because a shared endpoint change affects every peer. */
  updateServiceConfig: P2PCatalogView
  remoteRoots: P2PRemoteRootView[]
  /** One bounded page plus the true total, so paging never guesses. */
  remoteDirectory: { entries: P2PRemoteEntryView[]; total: number }
  /** Starting a connection returns the accepted attempt, never a ready state. */
  connect: P2PConnectionView
  disconnect: void
  /** Accepted means cancellation requested, never that a server write was undone. */
  cancel: { accepted: boolean }
}
export type P2PManagementOperation = keyof P2PManagementInputs
export type P2PManagementRequest<K extends P2PManagementOperation> = {
  version: typeof P2P_MANAGEMENT_VERSION
  requestId: number
} & P2PManagementInputs[K]
export type P2PManagementApi = Readonly<{
  [K in P2PManagementOperation]: (
    request: P2PManagementRequest<K>
  ) => Promise<ApiResult<P2PManagementResults[K], P2PManagementErrorCode>>
}>

/** Codes only, never native exception messages or helper-supplied arbitrary text. */
export const P2P_MANAGEMENT_ERROR_CODES = [
  'p2p.ipc_invalid_sender',
  'p2p.request_replayed',
  'p2p.request_limit',
  'p2p.request_unavailable',
  'p2p.internal_error',
  'p2p.authorization_cleanup_failed',
  'p2p.catalog_conflict',
  'p2p.catalog_exists',
  'p2p.catalog_incomplete',
  'p2p.catalog_invalid',
  'p2p.catalog_unavailable',
  'p2p.catalog_write_failed',
  'p2p.credential_cleanup_failed',
  'p2p.credential_conflict',
  'p2p.credential_create_failed',
  'p2p.credential_invalid',
  'p2p.credential_unavailable',
  'p2p.credential_write_failed',
  'p2p.device_unregistered',
  'p2p.enrollment_not_found',
  'p2p.enrollment_result_unconfirmed',
  'p2p.enrollment_state_mismatch',
  'p2p.helper_authentication_failed',
  'p2p.helper_busy',
  'p2p.helper_cleanup_failed',
  'p2p.helper_closed',
  'p2p.helper_integrity_failed',
  'p2p.helper_invalid',
  'p2p.helper_parent_unavailable',
  'p2p.helper_platform_unsupported',
  'p2p.helper_resource_unavailable',
  'p2p.helper_shutdown_failed',
  'p2p.helper_unavailable',
  'p2p.identity_mismatch',
  'p2p.insecure_socket_directory',
  'p2p.invalid_csr',
  'p2p.invalid_device_certificate',
  'p2p.invalid_device_key',
  'p2p.invalid_device_state',
  'p2p.invalid_enrollment_grant',
  'p2p.invalid_network_list',
  'p2p.invalid_operation',
  'p2p.invalid_payload',
  'p2p.invalid_request',
  'p2p.invalid_server_response',
  'p2p.invalid_service_endpoint',
  'p2p.invalid_service_identity',
  'p2p.invalid_signal_endpoint',
  'p2p.invalid_socket',
  'p2p.invalid_stun_endpoint',
  'p2p.invalid_user_session',
  'p2p.management_result_unconfirmed',
  'p2p.network_unavailable',
  'p2p.not_enabled',
  'p2p.operation_failed',
  'p2p.attempt_mismatch',
  'p2p.connection_busy',
  'p2p.connection_not_found',
  'p2p.invalid_peer_state',
  'p2p.runtime_request_unscoped',
  'p2p.stale_generation',
  'p2p.pair_expired',
  'p2p.partition_mismatch',
  'p2p.not_connected',
  'p2p.remote_directory_failed',
  'p2p.remote_path_forbidden',
  'p2p.remote_path_missing',
  'p2p.remote_reference_invalid',
  'p2p.remote_root_unauthorized',
  'p2p.remote_roots_unavailable',
  'p2p.pair_fingerprint_mismatch',
  'p2p.pair_not_found',
  'p2p.pair_state_mismatch',
  'p2p.invite_expired',
  'p2p.invite_invalid',
  'p2p.protocol_limit',
  'p2p.protocol_mismatch',
  'p2p.request_cancelled',
  'p2p.request_timeout',
  'p2p.secure_storage_unavailable',
  'p2p.server_unavailable',
  'p2p.service_busy',
  'p2p.service_exists',
  'p2p.service_not_found',
  'p2p.service_unconfigured',
  'p2p.settings_root_required',
  'p2p.trust_restore_rejected',
  'p2p.user_already_logged_in',
  'p2p.user_login_required',
  'p2p.user_scope_mismatch',
  'p2p.user_session_expired',
  'p2p.user_unauthorized'
] as const
export type P2PManagementErrorCode = (typeof P2P_MANAGEMENT_ERROR_CODES)[number]
