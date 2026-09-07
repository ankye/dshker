import { reactive } from 'vue'
import type { P2PRegistrationView } from '@/shared/p2p-management'
import { p2pManagement, type P2PManagementDomain } from './p2pManagement'

export interface P2PEnrollmentState {
  registration: P2PRegistrationView | undefined
  nameDraft: string
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
