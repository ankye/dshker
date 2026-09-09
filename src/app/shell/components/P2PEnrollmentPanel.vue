<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  p2pEnrollment as enrollment,
  p2pManagement as management,
  p2pAccounts as accounts
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'

const props = defineProps<{ serviceId: string }>()
const t = useTranslator()
const state = enrollment.state(props.serviceId)
const title = ref<HTMLHeadingElement>()
const busy = computed(() => management.busy(props.serviceId))
const operation = computed(() => {
  const current = management.operations[props.serviceId]
  return current &&
    ['registration', 'recoverEnrollment', 'submitEnrollment'].includes(current.method)
    ? current
    : undefined
})
/**
 * Codes that mean "this device is not registered yet".
 *
 * That is the normal state before enrollment, not a failure: the owner returns
 * these so the panel below can offer registration. Reporting them as an alert
 * told the user something was wrong when nothing was.
 */
const NOT_REGISTERED_CODES: readonly string[] = [
  'p2p.enrollment_not_found',
  'p2p.credential_unavailable'
]
const readFailure = computed(() => {
  const error = operation.value?.error
  if (!error || NOT_REGISTERED_CODES.includes(error)) return undefined
  return error
})
const sameUser = computed(
  () =>
    !!state.registration &&
    accounts.state(props.serviceId).user?.userId === state.registration.userId
)
const accountState = accounts.state(props.serviceId)
/** Registration needs an explicit network selection and a signed-in owner. */
const canRegister = computed(
  () =>
    state.registration === undefined &&
    !state.resultUnconfirmed &&
    accountState.user !== undefined &&
    accountState.selectedNetworkId !== undefined &&
    !busy.value
)
async function register(): Promise<void> {
  if (!canRegister.value) return
  await enrollment.register(props.serviceId, accountState.selectedNetworkId!)
}
const canSubmit = computed(
  () =>
    state.registration?.kind === 'pending' &&
    !state.resultUnconfirmed &&
    state.retryRevision === state.registration.revision &&
    sameUser.value
)

// The local credential is read on open rather than behind a button: a manual
// re-read produced nothing the panel had not already asked for.
onMounted(() => {
  if (!busy.value) void enrollment.read(props.serviceId)
})

async function submit() {
  if (!canSubmit.value || busy.value) return
  await enrollment.submit(props.serviceId)
  await nextTick()
  title.value?.focus()
}
</script>

<template>
  <section
    class="p2p-enrollment"
    :aria-label="t('p2p.enrollment.title')"
    data-testid="p2p-enrollment"
  >
    <h3 ref="title" tabindex="-1">{{ t('p2p.enrollment.title') }}</h3>
    <p>{{ t('p2p.enrollment.description') }}</p>
    <!-- First-run registration: no credential exists yet, so offer to create one. -->
    <form
      v-if="canRegister"
      class="p2p-enrollment-form"
      data-testid="p2p-register-form"
      @submit.prevent="register()"
    >
      <label>
        <span>{{ t('p2p.enrollment.name') }}</span>
        <input
          v-model="state.nameDraft"
          required
          autocomplete="off"
          data-testid="p2p-register-name"
        />
      </label>
      <button
        class="prototype-button prototype-button--primary"
        type="submit"
        :disabled="busy || !state.nameDraft"
        data-testid="p2p-register-submit"
      >
        {{ t('p2p.enrollment.register') }}
      </button>
      <p class="remote-form-hint">{{ t('p2p.enrollment.registerHint') }}</p>
    </form>
    <div class="p2p-enrollment-actions">
      <button
        v-if="state.registration?.kind === 'pending'"
        class="prototype-button"
        type="button"
        :disabled="busy"
        @click="enrollment.recover(serviceId)"
      >
        {{ t('p2p.enrollment.recover') }}
      </button>
      <button
        v-if="operation?.phase === 'pending'"
        class="prototype-button"
        type="button"
        @click="management.cancel(serviceId)"
      >
        {{ t('p2p.management.cancel') }}
      </button>
    </div>
    <p role="status" aria-live="polite">
      <template v-if="busy">{{
        operation?.phase === 'cancelling'
          ? t('p2p.management.cancelling')
          : t('p2p.management.pending')
      }}</template>

      <template v-else-if="state.registration?.kind === 'registered'">{{
        t('p2p.enrollment.registered')
      }}</template>
      <template v-else-if="state.registration?.kind === 'pending'">{{
        t('p2p.enrollment.pending')
      }}</template>
      <template v-else>{{ t('p2p.enrollment.unknown') }}</template>
    </p>
    <!-- "Not registered yet" is a state, not a failure. Both codes mean the same
         thing here: nothing is stored for this service, which is exactly what the
         panel below is for. -->
    <p v-if="readFailure" class="remote-error" role="alert" data-testid="p2p-enrollment-error">
      {{ t('p2p.enrollment.readFailed') }} <code>{{ readFailure }}</code>
    </p>
    <p v-if="operation?.cancelError" class="remote-error" role="alert">
      {{ t('p2p.management.cancelFailed') }} <code>{{ operation.cancelError }}</code>
    </p>
    <template v-if="state.registration">
      <dl>
        <div>
          <dt>{{ t('p2p.enrollment.name') }}</dt>
          <dd>{{ state.registration.name }}</dd>
        </div>
        <div>
          <dt>{{ t('p2p.enrollment.owner') }}</dt>
          <dd>
            <code>{{ state.registration.userId }}</code>
          </dd>
        </div>
        <div>
          <dt>{{ t('p2p.enrollment.publicKey') }}</dt>
          <dd>
            <code>{{ state.registration.publicKey }}</code>
          </dd>
        </div>
        <template v-if="state.registration.kind === 'pending'">
          <div>
            <dt>{{ t('p2p.enrollment.request') }}</dt>
            <dd>
              <code>{{ state.registration.requestId }}</code>
            </dd>
          </div>
          <div>
            <dt>{{ t('p2p.enrollment.network') }}</dt>
            <dd>
              <code>{{ state.registration.networkId }}</code>
            </dd>
          </div>
        </template>
        <div v-else>
          <dt>{{ t('p2p.enrollment.device') }}</dt>
          <dd>
            <code>{{ state.registration.deviceId }}</code>
          </dd>
        </div>
      </dl>
      <p v-if="state.resultUnconfirmed" role="status">{{ t('p2p.enrollment.unconfirmed') }}</p>
      <template
        v-if="
          state.registration.kind === 'pending' &&
          state.retryRevision === state.registration.revision &&
          !state.resultUnconfirmed
        "
      >
        <p>{{ t('p2p.enrollment.absent') }}</p>
        <p v-if="!sameUser">{{ t('p2p.enrollment.loginRequired') }}</p>
        <button
          class="prototype-button prototype-button--primary"
          type="button"
          :disabled="busy || !canSubmit"
          @click="submit"
        >
          {{ t('p2p.enrollment.submit') }}
        </button>
      </template>
    </template>
  </section>
</template>

<style scoped>
/* Same section language as the account card beside it. This was the only panel
 * on the screen still separated by a rule instead of a surface, which made the
 * screen read as one long list rather than a set of related cards. */
.p2p-enrollment {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}
.p2p-enrollment > h3 {
  margin: 0;
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  font-size: var(--type-section);
  font-weight: var(--font-weight-semibold);
}
.p2p-enrollment-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.p2p-enrollment dl > div {
  display: grid;
  grid-template-columns: minmax(0, 8rem) minmax(0, 1fr);
  gap: var(--space-3);
  padding-block: var(--space-2);
}
.p2p-enrollment dd {
  margin: 0;
}
.p2p-enrollment code,
.p2p-enrollment dd {
  overflow-wrap: anywhere;
}
.p2p-enrollment :focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}
</style>
