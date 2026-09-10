<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import {
  p2pAccounts as accounts,
  p2pConnections,
  p2pEnrollment as enrollment,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'

/**
 * 「我的网络」 card (Connect tab).
 *
 * The coordinator is always the built-in official server: there is no server
 * or endpoint configuration, and its endpoint fields are never shown. The card
 * always displays this device's name and identifier, and offers a login-free
 * join by networkId. Only a server-confirmed result is shown as registered,
 * and online status is only ever derived from a live connection stage, never
 * assumed.
 */
const t = useTranslator()

const catalog = management.catalog
const serviceId = computed(() => management.selectedServiceId.value)
const service = computed(() =>
  serviceId.value === undefined
    ? undefined
    : catalog.value?.services.find((entry) => entry.serviceId === serviceId.value)
)
const enrollmentState = computed(() =>
  serviceId.value === undefined ? undefined : enrollment.state(serviceId.value)
)
const operation = computed(() =>
  serviceId.value === undefined ? undefined : management.operations[serviceId.value]
)
const busy = computed(() => (serviceId.value ? management.busy(serviceId.value) : false))
const catalogOperation = computed(() => management.operations.catalog)
/** A read failure keeps catalog undefined, so expose it instead of claiming 'not configured'. */
const catalogError = computed(() =>
  catalogOperation.value?.phase === 'failed' ? catalogOperation.value.error : undefined
)
const catalogLoading = computed(
  () => catalog.value === undefined && catalogOperation.value?.phase === 'pending'
)
const registration = computed(() => enrollmentState.value?.registration)
const joining = computed(
  () => operation.value?.method === 'joinNetwork' && operation.value?.phase === 'pending'
)
const joinError = computed(() =>
  operation.value?.method === 'joinNetwork' && operation.value?.phase === 'failed'
    ? operation.value.error
    : undefined
)
const canJoin = computed(
  () =>
    !!service.value &&
    !registration.value &&
    !enrollmentState.value?.resultUnconfirmed &&
    !busy.value
)

const defaultDeviceName = () =>
  management.localDevice.value?.name ?? t('p2p.myNetwork.deviceNameDefault')
/** 设备名称: the server-stored name once registered, else this machine's hostname. */
const deviceName = computed(() =>
  registration.value?.kind === 'registered'
    ? registration.value.name
    : (management.localDevice.value?.name ?? t('p2p.myNetwork.deviceNameDefault'))
)
/**
 * 设备标识: the server-confirmed deviceId once registered, else this machine's
 * stable, machine-generated local device id (never a placeholder).
 */
const deviceId = computed(() =>
  registration.value?.kind === 'registered'
    ? registration.value.deviceId
    : (management.localDevice.value?.deviceId ?? '—')
)

/**
 * Leaving needs a signed-in owner.
 *
 * The coordinator has no login-free removal, so the action is offered only when a
 * session exists. Disabling it with a stated reason is honest; hiding it would
 * leave the user unable to tell whether leaving is possible at all.
 */
const signedIn = computed(() => {
  const id = serviceId.value
  return id ? !!accounts.state(id).user : false
})

const leaveError = computed(() =>
  operation.value?.method === 'leaveNetwork' && operation.value?.phase === 'failed'
    ? operation.value.error
    : undefined
)
const banned = computed(() => {
  const code = leaveError.value
  return code === 'p2p.network_revoked' || code === 'p2p.pair_revoked'
})
/** Presence evidence: only a live ready connection stage counts as online. */
const onlineEvidence = computed(() => {
  const id = serviceId.value
  if (!id) return false
  return (
    p2pConnections.state.peers?.some((peer) => peer.serviceId === id && peer.stage === 'ready') ??
    false
  )
})
/**
 * Whether this service has a pair that a connection could ever reach.
 *
 * Online here means a live ready connection, which requires a paired computer.
 * With none, that stage is unreachable, so reporting "offline" answered a
 * question the user never asked: an enrolled, reachable computer that simply has
 * nothing to connect to was labelled offline with no way to act on it.
 */
const hasActivePair = computed(() => {
  const id = serviceId.value
  if (!id) return false
  return (
    catalog.value?.computers.some(
      (computer) => computer.serviceId === id && computer.pairState === 'active'
    ) ?? false
  )
})
type NetworkStatus = 'online' | 'offline' | 'banned' | 'unpaired'
const STATUS_KEYS: Readonly<Record<NetworkStatus, MessageKey>> = {
  online: 'p2p.myNetwork.online',
  offline: 'p2p.myNetwork.offline',
  banned: 'p2p.myNetwork.banned',
  unpaired: 'p2p.myNetwork.unpaired'
}
const networkStatus = computed<NetworkStatus>(() => {
  if (registration.value?.kind !== 'registered') return 'offline'
  if (banned.value) return 'banned'
  if (onlineEvidence.value) return 'online'
  // Keep the strict definition of online, but do not present an unreachable
  // stage as a connection state the user could correct.
  return hasActivePair.value ? 'offline' : 'unpaired'
})

const JOIN_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  'p2p.network_full': 'p2p.join.error.networkFull',
  'p2p.invalid_enrollment': 'p2p.join.error.invalid',
  'p2p.invalid_enrollment_token': 'p2p.join.error.invalid',
  'p2p.invalid_enrollment_grant': 'p2p.join.error.invalid',
  'p2p.network_unavailable': 'p2p.join.error.unknownNetwork',
  'p2p.network_revoked': 'p2p.join.error.unknownNetwork',
  'p2p.invalid_operation': 'p2p.join.error.unavailable',
  'p2p.operation_failed': 'p2p.join.error.unavailable',
  'p2p.unknown_operation': 'p2p.join.error.unavailable',
  bridge: 'p2p.join.error.unavailable'
}
const joinErrorKey = computed<MessageKey>(() => {
  const code = joinError.value
  if (!code) return 'p2p.join.error.generic'
  if (code === 'unconfirmed') return 'p2p.join.error.unconfirmed'
  return JOIN_ERROR_KEYS[code] ?? 'p2p.join.error.generic'
})

/** Re-reads the catalog and re-provisions the built-in service after a failure. */
async function retryProvision(): Promise<void> {
  await management.readLocalDevice()
  await management.ensureBuiltinService()
  const id = serviceId.value
  if (id && !management.busy(id)) void enrollment.read(id)
}

/** Seeds the device name once per service so an empty draft never reaches a join. */
function ensureNameDraft(): void {
  const state = enrollmentState.value
  if (state && !state.joinNameDraft) state.joinNameDraft = defaultDeviceName()
}

/**
 * Provisions the built-in service, then reflects an existing registration so
 * the card never offers a redundant join.
 */
onMounted(async () => {
  void management.readLocalDevice()
  await management.ensureBuiltinService()
  ensureNameDraft()
  const id = serviceId.value
  if (id && !management.busy(id)) {
    void enrollment.read(id)
    void p2pConnections.read()
  }
})

// Re-read when a service is selected after provisioning completed.
watch(serviceId, (id, previous) => {
  if (id && id !== previous && !management.busy(id)) {
    ensureNameDraft()
    void enrollment.read(id)
    void p2pConnections.read()
  }
})

async function join(): Promise<void> {
  const id = serviceId.value
  const state = enrollmentState.value
  if (!id || !state || !canJoin.value) return
  const networkId = state.joinNetworkIdDraft.trim()
  if (!networkId) return
  await enrollment.join(id, networkId, deviceName.value)
}

async function cancelRequest(): Promise<void> {
  const id = serviceId.value
  if (!id || busy.value) return
  await enrollment.cancelJoin(id)
}

async function leave(): Promise<void> {
  const id = serviceId.value
  const state = enrollmentState.value
  const reg = registration.value
  if (!id || !state || reg?.kind !== 'registered' || busy.value) return
  const networkId = state.joinNetworkIdDraft.trim()
  await enrollment.leave(id, networkId, reg.deviceId)
}
</script>
<template>
  <section
    class="remote-add-card p2p-join"
    aria-labelledby="p2p-my-network-title"
    data-testid="p2p-join-panel"
  >
    <div class="remote-section-heading">
      <div>
        <h2 id="p2p-my-network-title">{{ t('p2p.myNetwork.title') }}</h2>
        <p>{{ t('p2p.myNetwork.officialServer') }}</p>
      </div>
    </div>

    <p v-if="catalogError" role="alert" class="remote-error" data-testid="p2p-catalog-error">
      {{ t('p2p.myNetwork.catalogReadFailed') }}
      <code>{{ catalogError }}</code>
      <button
        class="prototype-button"
        type="button"
        :disabled="catalogLoading"
        @click="retryProvision"
      >
        {{ t('p2p.myNetwork.retry') }}
      </button>
    </p>
    <p v-else-if="catalogLoading" role="status" data-testid="p2p-catalog-loading">
      {{ t('p2p.myNetwork.catalogLoading') }}
    </p>
    <p v-else-if="catalog === undefined">{{ t('p2p.management.notLoaded') }}</p>
    <p
      v-else-if="management.builtinRemoved.value"
      role="alert"
      class="remote-error"
      data-testid="p2p-builtin-removed"
    >
      {{ t('p2p.myNetwork.builtinRemoved') }}
    </p>
    <p v-else-if="catalog === null">{{ t('p2p.management.disabled') }}</p>
    <p v-else-if="!service" data-testid="p2p-service-unavailable">
      {{ t('p2p.myNetwork.serviceUnavailable') }}
    </p>
    <template v-else>
      <!-- This device's identity leads: it is the one fact that is true in every
           phase, and it answers "which machine am I looking at" before anything
           asks the user to act. -->
      <dl class="p2p-device-info" data-testid="p2p-device-info">
        <div>
          <dt>{{ t('p2p.myNetwork.deviceName') }}</dt>
          <dd>{{ deviceName }}</dd>
        </div>
        <div>
          <dt>{{ t('p2p.myNetwork.deviceId') }}</dt>
          <dd>
            <code>{{ deviceId }}</code>
          </dd>
        </div>
      </dl>

      <!-- Joined: status and the one destructive action, no input to re-join. -->
      <div
        v-if="registration?.kind === 'registered'"
        class="p2p-joined"
        data-testid="p2p-joined-state"
      >
        <p
          class="p2p-network-status"
          role="status"
          :data-state="networkStatus"
          data-testid="p2p-network-status"
        >
          {{ t(STATUS_KEYS[networkStatus]) }}
        </p>
        <p v-if="leaveError" role="alert" class="remote-error" data-testid="p2p-leave-error">
          {{ t('p2p.myNetwork.leaveError') }} <code>{{ leaveError }}</code>
        </p>
        <div class="p2p-joined__actions">
          <button
            class="prototype-button prototype-button--danger"
            type="button"
            :disabled="busy || !signedIn"
            data-testid="p2p-leave-network"
            @click="leave"
          >
            {{ t('p2p.myNetwork.leave') }}
          </button>
          <!-- Stated rather than implied: a disabled button with no reason reads
               as a defect. -->
          <p v-if="!signedIn" class="remote-form-hint" data-testid="p2p-leave-requires-login">
            {{ t('p2p.devices.leaveRequiresLogin') }}
          </p>
        </div>
      </div>

      <!-- Pending: input disabled, cancel action, awaiting approval. -->
      <div v-else-if="registration?.kind === 'pending'" data-testid="p2p-pending-state">
        <label class="p2p-pending-field">
          <span>{{ t('p2p.myNetwork.networkIdLabel') }}</span>
          <input
            :value="enrollmentState!.joinNetworkIdDraft"
            type="text"
            disabled
            data-testid="p2p-pending-network"
          />
        </label>
        <button
          class="prototype-button"
          type="button"
          :disabled="busy"
          data-testid="p2p-cancel-request"
          @click="cancelRequest"
        >
          {{ t('p2p.myNetwork.cancelRequest') }}
        </button>
        <p class="remote-form-hint" role="status" data-testid="p2p-pending-status">
          {{ t('p2p.myNetwork.waitingApproval') }}
        </p>
      </div>

      <!-- Not joined: network ID + join. -->
      <form v-else class="p2p-join-form" data-testid="p2p-join-form" @submit.prevent="join">
        <label>
          <span>{{ t('p2p.myNetwork.networkIdLabel') }}</span>
          <input
            v-model="enrollmentState!.joinNetworkIdDraft"
            type="text"
            required
            autocomplete="off"
            spellcheck="false"
            data-testid="p2p-join-network"
          />
        </label>
        <button
          class="prototype-button prototype-button--primary"
          type="submit"
          :disabled="!canJoin || !enrollmentState!.joinNetworkIdDraft.trim()"
          data-testid="p2p-join-submit"
        >
          {{ joining ? t('p2p.myNetwork.joining') : t('p2p.myNetwork.join') }}
        </button>
        <p class="remote-form-hint">{{ t('p2p.myNetwork.notJoinedHint') }}</p>
      </form>

      <p v-if="joinError" role="alert" class="remote-error" data-testid="p2p-join-error">
        {{ t(joinErrorKey) }} <code>{{ joinError }}</code>
      </p>
      <p v-if="enrollmentState!.resultUnconfirmed" role="alert" class="remote-error">
        {{ t('p2p.join.error.unconfirmed') }}
      </p>
    </template>
  </section>
</template>

<style scoped>
/* One vertical rhythm for the whole card, so each phase block is separated the
   same way regardless of which one is showing. */
.p2p-join {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
/* Identity reads as a definition list: label above value at narrow widths, and
   two aligned columns once there is room to compare them. */
.p2p-device-info {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface-raised);
}
.p2p-device-info > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
@media (width >= 30rem) {
  .p2p-device-info > div {
    grid-template-columns: minmax(0, 8rem) minmax(0, 1fr);
    align-items: baseline;
    gap: var(--space-3);
  }
}
.p2p-device-info dt {
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.p2p-device-info dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.p2p-join-form {
  display: grid;
  grid-template-columns: minmax(10rem, 1fr) auto;
  align-items: end;
  gap: var(--space-3);
}
.p2p-join-form label,
.p2p-pending-field {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.p2p-join-form input,
.p2p-pending-field input {
  min-width: 0;
  width: 100%;
  min-height: var(--size-control-md);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
}
.p2p-join input:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}
.p2p-join input:disabled,
.p2p-pending-field input:disabled {
  border-color: var(--color-border);
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  opacity: 0.6;
}
.p2p-join-form .remote-form-hint,
.p2p-pending-field + .remote-form-hint {
  grid-column: 1 / -1;
  margin: 0;
}
.p2p-joined,
.p2p-pending-state {
  display: grid;
  gap: var(--space-3);
}
/* The destructive action and its explanation stay together, so the reason a
   button is unavailable is never separated from the button. */
.p2p-joined__actions {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.p2p-joined__actions .remote-form-hint {
  margin: 0;
}
/* Status is a badge, not a sentence: it is scanned, so it needs a shape that
   separates it from the body copy around it. */
.p2p-network-status {
  justify-self: start;
  margin: 0;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  font-size: var(--type-label);
  font-weight: var(--font-weight-medium);
  line-height: var(--size-control-sm);
}
.p2p-network-status[data-state='online'] {
  color: var(--color-success);
}
.p2p-network-status[data-state='offline'] {
  color: var(--color-text-muted);
}
.p2p-network-status[data-state='banned'] {
  color: var(--color-danger);
}
/* Having no pair is a neutral fact about setup, not a fault, so it reads muted
 * like offline rather than taking the danger role. */
.p2p-network-status[data-state='unpaired'] {
  color: var(--color-text-muted);
}
.remote-error code {
  overflow-wrap: anywhere;
}
</style>
