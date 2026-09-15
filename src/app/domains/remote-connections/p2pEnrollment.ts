import { reactive } from 'vue'
import type { P2PRegistrationView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PEnrollmentState {
  registration: P2PRegistrationView | undefined
  nameDraft: string
  /** Drafts of the login-free join form, preserved across tab switches. */
  joinNetworkIdDraft: string
  joinNameDraft: string
  resultUnconfirmed: boolean
  retryRevision: string | undefined
  /**
   * The device ids the signed-in account is bound to, or undefined while unread.
   *
   * A device id can be bound to more than one account, so whether this machine
   * belongs to the account signed in here is a question only the coordinator can
   * answer; `undefined` stays distinct from "not bound", because an unread list is
   * not evidence that the machine is foreign.
   */
  accountDeviceIds: string[] | undefined
}

/** Public registration state only. Keys, CSR, certificates and grants remain in main. */
export class P2PEnrollmentDomain {
  readonly #states = reactive<Record<string, P2PEnrollmentState>>({})
  #unsubscribe: (() => void) | undefined
  /** The coordinator whose announcements this domain currently follows. */
  #serviceId: string | undefined
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): P2PEnrollmentState {
    if (!this.#states[serviceId])
      this.#states[serviceId] = {
        registration: undefined,
        nameDraft: '',
        joinNetworkIdDraft: '',
        joinNameDraft: '',
        resultUnconfirmed: false,
        retryRevision: undefined,
        accountDeviceIds: undefined
      }
    return this.#states[serviceId]
  }

  async read(serviceId: string): Promise<void> {
    const result = await this.management.runRead('registration', { serviceId })
    if (result.ok) {
      const state = this.state(serviceId)
      state.registration = result.data
      state.retryRevision = undefined
      state.resultUnconfirmed = result.data.kind === 'pending'
    }
    // A missing/unreadable record is an error, never an inferred unregistered state.
  }

  /**
   * Reads the device ids the signed-in account is bound to.
   *
   * This is what decides whether the machine's own identity belongs to the account
   * signed in here. The account recorded in the local credential cannot answer it:
   * that is the account the machine first enrolled under, and a device added to
   * another account's network by hand keeps it — so a legitimate, bound machine
   * looked like a foreign one.
   *
   * The read answers from the core's cached directory, because a forced coordinator
   * read here made the Connect page ask the server on every mount and turned a
   * directory the core had not read yet into an empty list — which the card read as
   * the positive claim "this machine is not bound" and reported a foreign identity
   * for a perfectly bound computer. A refusal and an unread snapshot therefore both
   * leave the list as it is: neither is evidence about the account, and the card
   * already treats `undefined` as "not looked yet".
   */
  async readAccountDevices(serviceId: string): Promise<void> {
    this.subscribe(serviceId)
    const result = await this.management.runRead('directory', { serviceId })
    if (!result.ok || !result.data.known) return
    this.state(serviceId).accountDeviceIds = result.data.devices.map((device) => device.deviceId)
  }

  /**
   * Follows the directory changes the core announces.
   *
   * The snapshot can legitimately be unread when the Connect page mounts: the core
   * begins its own read at startup, after it first sees a session. Without the
   * subscription the identity check would stay unanswered until something else
   * happened to move, which is exactly the state this read exists to resolve.
   */
  subscribe(serviceId: string): void {
    // The page can switch coordinators. Only an announcement for the one it now
    // shows is worth re-reading; an announcement for a stale one is ignored rather
    // than answered with a read nobody asked for.
    this.#serviceId = serviceId
    if (this.#unsubscribe !== undefined) return
    const api = window.dshLauncher?.p2pManagement
    if (api?.onDirectoryChange === undefined) return
    this.#unsubscribe = api.onDirectoryChange((event) => {
      if (event.serviceId !== this.#serviceId) return
      void this.readAccountDevices(event.serviceId)
    })
  }

  /** Releases the subscription; used by tests and any future shell teardown. */
  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  async register(serviceId: string, networkId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.registration || state.resultUnconfirmed || this.management.busy(serviceId)) return
    const name = state.nameDraft
    const result = await this.management.run('registerDevice', { serviceId, networkId, name })
    if (result.ok) {
      state.registration = result.data
      if (state.nameDraft === name) state.nameDraft = ''
    } else if (
      !['bridge', 'p2p.service_busy', 'p2p.invalid_request', 'p2p.user_login_required'].includes(
        result.code
      )
    ) {
      state.resultUnconfirmed = true
    }
  }

  /**
   * Login-free join: enrolls the local device into a network by networkId.
   *
   * The device identity already exists locally, so no login or network
   * selection is required. Only a server-confirmed result is stored as
   * 'registered'; a typed refusal (for example 'p2p.network_full') never
   * manufactures a registration and leaves the form retryable.
   */
  async join(serviceId: string, networkId: string, name: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.registration || state.resultUnconfirmed || this.management.busy(serviceId)) return
    const result = await this.management.run('joinNetwork', { serviceId, networkId, name })
    if (result.ok) {
      state.registration = result.data
      state.retryRevision = undefined
      // A pending reply is not a registration; keep requiring explicit readback.
      state.resultUnconfirmed = result.data.kind === 'pending'
      // Drafts are kept so the Connect card can echo which network was joined.
      return
    }
    // Only these errors prove no write was admitted. Anything else may have
    // happened during readback after the server already enrolled the device.
    if (!refusedBeforeEffect(result.code)) state.resultUnconfirmed = true
  }

  /**
   * Cancel a pending login-free join without inventing a server outcome.
   *
   * Reads the registration back: a pending enrollment the server still holds
   * stays pending, and a readback that proves no registration exists (no
   * local record, or the server reports the enrollment was never found)
   * clears the local pending draft so the user may join again. Any other
   * failure leaves the pending registration untouched.
   */
  async cancelJoin(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.registration?.kind !== 'pending' || this.management.busy(serviceId)) return
    const result = await this.management.run('registration', { serviceId })
    if (result.ok) {
      // The readback still holds a registration; adopt whatever it reports.
      state.registration = result.data
      state.retryRevision = undefined
      state.resultUnconfirmed = result.data.kind === 'pending'
      return
    }
    if (
      result.code === 'p2p.credential_unavailable' ||
      result.code === 'p2p.enrollment_not_found'
    ) {
      state.registration = undefined
      state.resultUnconfirmed = false
      state.retryRevision = undefined
    }
  }

  /**
   * Leave a network the device joined.
   *
   * Requires a signed-in owner. The coordinator has no login-free removal, and
   * that asymmetry with join is deliberate: holding a networkId is enough to add
   * a device, but without a cryptographic proof it must not be enough to evict
   * one, or any holder of a deviceId could remove someone else's machine.
   *
   * Only a server-confirmed removal clears the local registration. A typed
   * refusal never fakes a leave: the registration stays and the caller surfaces
   * the error.
   */
  async leave(serviceId: string, networkId: string, deviceId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.registration?.kind !== 'registered' || this.management.busy(serviceId)) return
    if (!networkId || !deviceId) return
    const result = await this.management.run('leaveNetwork', { serviceId, networkId, deviceId })
    if (result.ok) {
      state.registration = undefined
      state.resultUnconfirmed = false
      state.retryRevision = undefined
      state.joinNetworkIdDraft = ''
      return
    }
    // A typed refusal proves no removal; a lost reply may have taken effect.
    if (!refusedBeforeEffect(result.code)) state.resultUnconfirmed = true
  }

  async recover(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    if (state.registration?.kind !== 'pending' || this.management.busy(serviceId)) return
    const revision = state.registration.revision
    state.retryRevision = undefined
    const result = await this.management.run('recoverEnrollment', {
      serviceId,
      revision: state.registration.revision
    })
    if (result.ok) {
      state.registration = result.data
      state.resultUnconfirmed = false
    } else {
      state.resultUnconfirmed = result.code !== 'p2p.enrollment_not_found'
      if (result.code === 'p2p.enrollment_not_found') state.retryRevision = revision
    }
  }

  async submit(serviceId: string): Promise<void> {
    const state = this.state(serviceId)
    if (
      state.registration?.kind !== 'pending' ||
      this.management.busy(serviceId) ||
      state.resultUnconfirmed ||
      state.retryRevision !== state.registration.revision
    )
      return
    // Consume the explicit readback permission before dispatch; never replay a lost write.
    state.retryRevision = undefined
    const result = await this.management.run('submitEnrollment', {
      serviceId,
      revision: state.registration.revision
    })
    if (result.ok) {
      state.registration = result.data
      state.resultUnconfirmed = false
    } else state.resultUnconfirmed = true
  }
}

export const p2pEnrollment = new P2PEnrollmentDomain(p2pManagement)

/**
 * Codes that prove the server admitted no enrollment write at all.
 *
 * Any other failure may have happened after the server already recorded the
 * device, so it is surfaced as unconfirmed and never silently retried.
 */
function refusedBeforeEffect(code: string): boolean {
  return [
    'bridge',
    'p2p.service_busy',
    'p2p.invalid_request',
    'p2p.invalid_operation',
    'p2p.not_enabled',
    'p2p.user_login_required',
    'p2p.network_full',
    'p2p.invalid_network_limit',
    'p2p.invalid_enrollment',
    'p2p.invalid_enrollment_token',
    'p2p.invalid_enrollment_grant',
    'p2p.device_already_enrolled',
    'p2p.enrollment_state_mismatch'
  ].includes(code)
}
