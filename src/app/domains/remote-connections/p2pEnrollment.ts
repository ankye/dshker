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
}

/** Public registration state only. Keys, CSR, certificates and grants remain in main. */
export class P2PEnrollmentDomain {
  readonly #states = reactive<Record<string, P2PEnrollmentState>>({})
  constructor(private readonly management: P2PManagementDomain) {}

  state(serviceId: string): P2PEnrollmentState {
    if (!this.#states[serviceId])
      this.#states[serviceId] = {
        registration: undefined,
        nameDraft: '',
        joinNetworkIdDraft: '',
        joinNameDraft: '',
        resultUnconfirmed: false,
        retryRevision: undefined
      }
    return this.#states[serviceId]
  }

  async read(serviceId: string): Promise<void> {
    const result = await this.management.run('registration', { serviceId })
    if (result.ok) {
      const state = this.state(serviceId)
      state.registration = result.data
      state.retryRevision = undefined
      state.resultUnconfirmed = result.data.kind === 'pending'
    }
    // A missing/unreadable record is an error, never an inferred unregistered state.
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
