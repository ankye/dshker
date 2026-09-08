import { computed, ref } from 'vue'
import type { P2PServiceView } from '@/shared/p2p-management'
import { p2pManagement } from './p2pManagement'

interface ServiceDraft {
  displayName: string
  httpsOrigin: string
  wssUrl: string
  stunAddress: string
}

/**
 * Editing state for the shared configuration of one P2P service.
 *
 * The configuration is shared by every computer paired through the service, so
 * saving is refused while any of them is busy, and a failure leaves both the
 * stored record and the user's input untouched so nothing is half-applied and
 * nothing has to be retyped.
 *
 * Enrollment secrets are never part of a draft: only the four public endpoint
 * fields live here.
 */
const original = ref<P2PServiceView>()
const draft = ref<ServiceDraft>()
const revision = ref<string>()
const discardRequested = ref(false)
const nextTarget = ref<string>()
/** Set when a save may have taken effect; blocks another save until readback. */
const resultUnconfirmed = ref(false)
const conflict = ref(false)

const dirty = computed(() => {
  const saved = original.value
  const current = draft.value
  return (
    saved !== undefined &&
    current !== undefined &&
    (saved.displayName !== current.displayName ||
      saved.httpsOrigin !== current.httpsOrigin ||
      saved.wssUrl !== current.wssUrl ||
      saved.stunAddress !== current.stunAddress)
  )
})

/** True only when a save is genuinely safe to dispatch. */
const canSave = computed(
  () =>
    dirty.value &&
    !resultUnconfirmed.value &&
    original.value !== undefined &&
    revision.value !== undefined &&
    !p2pManagement.busy(original.value.serviceId)
)

function open(service: P2PServiceView, catalogRevision: string): boolean {
  if (dirty.value && original.value?.serviceId !== service.serviceId) {
    nextTarget.value = service.serviceId
    discardRequested.value = true
    return false
  }
  if (original.value?.serviceId === service.serviceId) {
    // Keep the in-progress draft, but track the newest revision.
    revision.value = catalogRevision
    return true
  }
  original.value = { ...service }
  revision.value = catalogRevision
  conflict.value = false
  draft.value = {
    displayName: service.displayName,
    httpsOrigin: service.httpsOrigin,
    wssUrl: service.wssUrl,
    stunAddress: service.stunAddress
  }
  return true
}

function close(): boolean {
  if (dirty.value) {
    nextTarget.value = undefined
    discardRequested.value = true
    return false
  }
  clear()
  return true
}

function clear(): void {
  original.value = undefined
  draft.value = undefined
  revision.value = undefined
  discardRequested.value = false
  conflict.value = false
}

/**
 * Saves the shared endpoints.
 *
 * Returns true only when the server confirmed the write. Input is preserved on
 * every failure, and an outcome that may have taken effect is recorded so the
 * user is told to read back instead of submitting again.
 */
async function save(): Promise<boolean> {
  const service = original.value
  const current = draft.value
  const expected = revision.value
  if (!service || !current || !expected || !canSave.value) return false
  conflict.value = false
  const result = await p2pManagement.run('updateServiceConfig', {
    serviceId: service.serviceId,
    revision: expected,
    displayName: current.displayName,
    httpsOrigin: current.httpsOrigin,
    wssUrl: current.wssUrl,
    stunAddress: current.stunAddress
  })
  if (result.ok) {
    // Keep the shared catalog in sync so the server list shows the confirmed endpoints.
    p2pManagement.catalog.value = result.data
    const saved = result.data.services.find((entry) => entry.serviceId === service.serviceId)
    if (saved) {
      original.value = { ...saved }
      draft.value = {
        displayName: saved.displayName,
        httpsOrigin: saved.httpsOrigin,
        wssUrl: saved.wssUrl,
        stunAddress: saved.stunAddress
      }
    }
    revision.value = result.data.revision
    resultUnconfirmed.value = false
    return true
  }
  // A stale revision or a busy peer is a definite refusal: nothing was written.
  const refusedBeforeEffect = [
    'bridge',
    'p2p.catalog_conflict',
    'p2p.service_busy',
    'p2p.service_exists',
    'p2p.service_not_found',
    'p2p.identity_mismatch',
    'p2p.invalid_request',
    'p2p.trust_restore_rejected',
    'p2p.request_cancelled'
  ]
  conflict.value = result.code === 'p2p.catalog_conflict'
  if (!refusedBeforeEffect.includes(result.code)) resultUnconfirmed.value = true
  return false
}

export const p2pServiceEditor = {
  original,
  draft,
  revision,
  dirty,
  canSave,
  conflict,
  resultUnconfirmed,
  discardRequested,
  open,
  close,
  clear,
  save,
  /** Clears an unknown outcome once fresh state has been read back. */
  acknowledgeReadback: (service: P2PServiceView, catalogRevision: string) => {
    resultUnconfirmed.value = false
    original.value = { ...service }
    revision.value = catalogRevision
    conflict.value = false
  },
  discard: () => {
    const target = nextTarget.value
    nextTarget.value = undefined
    clear()
    return target
  },
  keep: () => {
    discardRequested.value = false
    nextTarget.value = undefined
  }
}
