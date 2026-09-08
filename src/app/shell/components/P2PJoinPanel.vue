<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  p2pEnrollment as enrollment,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'

/**
 * Join-network card (Connect tab).
 *
 * Enrollment into a network keyed by networkId is login-free: this device's
 * identity already exists, so no user session or network selection is
 * required. Only a server-confirmed result is shown as registered; a typed
 * refusal (for example p2p.network_full) is never turned into a registration.
 */
const t = useTranslator()
const emit = defineEmits<{ 'navigate-account': [] }>()

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
const joining = computed(
  () => operation.value?.method === 'joinNetwork' && operation.value?.phase === 'pending'
)
const busy = computed(() => (serviceId.value ? management.busy(serviceId.value) : false))
const joinError = computed(() =>
  operation.value?.method === 'joinNetwork' && operation.value?.phase === 'failed'
    ? operation.value.error
    : undefined
)
/** Join starts clean; anything registered for this service blocks a second join. */
const registration = computed(() => enrollmentState.value?.registration)
const canJoin = computed(
  () =>
    !!service.value &&
    !registration.value &&
    !enrollmentState.value?.resultUnconfirmed &&
    !busy.value
)

/**
 * Non-optional enrollment state; valid only while a server is selected.
 *
 * The template calls this inside the `v-else` branch guarded by `service`, so a
 * missing state is a programming error rather than a rendering fallback.
 */
function draftState(): NonNullable<typeof enrollmentState.value> {
  const state = enrollmentState.value
  if (!state) throw new Error('P2PJoinPanel rendered without a selected service')
  return state
}

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

// Reflect an existing local registration when a server is chosen, so the card
// does not offer a redundant join. The read is login-free and never fabricated.
watch(serviceId, (id, previous) => {
  if (id && id !== previous && !management.busy(id)) void enrollment.read(id)
})

async function join(): Promise<void> {
  const id = serviceId.value
  const state = enrollmentState.value
  if (!id || !state || !canJoin.value) return
  const networkId = state.joinNetworkIdDraft.trim()
  const name = state.joinNameDraft.trim()
  if (!networkId || !name) return
  await enrollment.join(id, networkId, name)
}
</script>
<template>
  <section
    class="remote-add-card p2p-join"
    aria-labelledby="p2p-join-title"
    data-testid="p2p-join-panel"
  >
    <div class="remote-section-heading">
      <div>
        <h2 id="p2p-join-title">{{ t('p2p.join.title') }}</h2>
        <p>{{ t('p2p.join.description') }}</p>
      </div>
    </div>

    <p v-if="catalog === undefined">{{ t('p2p.management.notLoaded') }}</p>
    <p v-else-if="catalog === null">{{ t('p2p.join.noService') }}</p>
    <template v-else>
      <p v-if="catalog.services.length === 0">{{ t('p2p.join.noService') }}</p>
      <p v-else-if="!service">{{ t('p2p.join.selectService') }}</p>
      <template v-else>
        <!-- Registered: shown for any server-confirmed registration, pending or final. -->
        <div
          v-if="registration?.kind === 'registered'"
          class="p2p-join-state"
          role="status"
          data-testid="p2p-join-registered"
        >
          <strong>{{ t('p2p.join.registered') }}</strong>
          <dl>
            <div>
              <dt>{{ t('p2p.enrollment.name') }}</dt>
              <dd>{{ registration.name }}</dd>
            </div>
            <div>
              <dt>{{ t('p2p.enrollment.device') }}</dt>
              <dd>
                <code>{{ registration.deviceId }}</code>
              </dd>
            </div>
            <div v-if="draftState().joinNetworkIdDraft">
              <dt>{{ t('p2p.join.networkIdLabel') }}</dt>
              <dd>
                <code>{{ draftState().joinNetworkIdDraft }}</code>
              </dd>
            </div>
          </dl>
          <p class="remote-form-hint">{{ t('p2p.join.registeredHint') }}</p>
          <button
            class="prototype-button prototype-button--primary"
            type="button"
            data-testid="p2p-join-go-account"
            @click="emit('navigate-account')"
          >
            {{ t('p2p.join.goAccount') }}
          </button>
        </div>
        <div
          v-else-if="registration?.kind === 'pending'"
          role="status"
          data-testid="p2p-join-pending"
        >
          <strong>{{ t('p2p.join.pending') }}</strong>
          <p class="remote-form-hint">{{ t('p2p.join.pendingHint') }}</p>
        </div>

        <form
          v-if="!registration"
          class="p2p-join-form"
          data-testid="p2p-join-form"
          @submit.prevent="join"
        >
          <label>
            <span>{{ t('p2p.join.networkIdLabel') }}</span>
            <input
              v-model="draftState().joinNetworkIdDraft"
              type="text"
              required
              autocomplete="off"
              spellcheck="false"
              data-testid="p2p-join-network"
            />
          </label>
          <label>
            <span>{{ t('p2p.join.nameLabel') }}</span>
            <input
              v-model="draftState().joinNameDraft"
              type="text"
              required
              autocomplete="off"
              data-testid="p2p-join-name"
            />
          </label>
          <button
            class="prototype-button prototype-button--primary"
            type="submit"
            :disabled="
              !canJoin ||
              !draftState().joinNetworkIdDraft.trim() ||
              !draftState().joinNameDraft.trim()
            "
            data-testid="p2p-join-submit"
          >
            {{ joining ? t('p2p.join.joining') : t('p2p.join.action') }}
          </button>
        </form>

        <p v-if="joining" role="status" class="p2p-join-loading" data-testid="p2p-join-loading">
          {{ t('p2p.join.joining') }}
        </p>
        <p v-if="joinError" role="alert" class="remote-error" data-testid="p2p-join-error">
          {{ t(joinErrorKey) }} <code>{{ joinError }}</code>
        </p>
        <p v-if="draftState().resultUnconfirmed" role="alert" class="remote-error">
          {{ t('p2p.join.error.unconfirmed') }}
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.p2p-join {
  min-width: 0;
}
.p2p-join-form {
  display: grid;
  grid-template-columns: minmax(10rem, 1fr) minmax(10rem, 1fr) auto;
  align-items: end;
  gap: var(--space-3);
}
.p2p-join-form label {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.p2p-join-form input {
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
.p2p-join-loading {
  margin: 0;
}
.p2p-join-state {
  display: grid;
  gap: var(--space-2);
}
.p2p-join-state dl > div {
  display: grid;
  grid-template-columns: minmax(0, 10rem) minmax(0, 1fr);
  gap: var(--space-3);
  padding-block: var(--space-1);
}
.p2p-join-state dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
