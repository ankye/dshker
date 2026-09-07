<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
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
  return current && ['registration', 'recoverEnrollment', 'submitEnrollment'].includes(current.method)
    ? current : undefined
})
const sameUser = computed(() => !!state.registration &&
  accounts.state(props.serviceId).user?.userId === state.registration.userId)
const canSubmit = computed(() => state.registration?.kind === 'pending' &&
  !state.resultUnconfirmed && state.retryRevision === state.registration.revision && sameUser.value)

async function submit() {
  if (!canSubmit.value || busy.value) return
  await enrollment.submit(props.serviceId)
  await nextTick()
  title.value?.focus()
}
</script>

<template>
  <section class="p2p-enrollment" :aria-label="t('p2p.enrollment.title')" data-testid="p2p-enrollment">
    <h3 ref="title" tabindex="-1">{{ t('p2p.enrollment.title') }}</h3>
    <p>{{ t('p2p.enrollment.description') }}</p>
    <div class="p2p-enrollment-actions">
      <button class="prototype-button" type="button" :disabled="busy" @click="enrollment.read(serviceId)">
        {{ t('p2p.enrollment.read') }}
      </button>
      <button v-if="state.registration?.kind === 'pending'" class="prototype-button" type="button"
        :disabled="busy" @click="enrollment.recover(serviceId)">
        {{ t('p2p.enrollment.recover') }}
      </button>
      <button v-if="operation?.phase === 'pending'" class="prototype-button" type="button"
        @click="management.cancel(serviceId)">{{ t('p2p.management.cancel') }}</button>
    </div>
    <p role="status" aria-live="polite">
      <template v-if="busy">{{ operation?.phase === 'cancelling'
        ? t('p2p.management.cancelling') : t('p2p.management.pending') }}</template>
      <template v-else-if="state.registration?.kind === 'registered'">{{ t('p2p.enrollment.registered') }}</template>
      <template v-else-if="state.registration?.kind === 'pending'">{{ t('p2p.enrollment.pending') }}</template>
      <template v-else>{{ t('p2p.enrollment.unknown') }}</template>
    </p>
    <p v-if="operation?.error && operation.error !== 'p2p.enrollment_not_found'" class="remote-error" role="alert">
      {{ t('p2p.enrollment.readFailed') }} <code>{{ operation.error }}</code>
    </p>
    <p v-if="operation?.cancelError" class="remote-error" role="alert">
      {{ t('p2p.management.cancelFailed') }} <code>{{ operation.cancelError }}</code>
    </p>
    <template v-if="state.registration">
      <dl>
        <div><dt>{{ t('p2p.enrollment.name') }}</dt><dd>{{ state.registration.name }}</dd></div>
        <div><dt>{{ t('p2p.enrollment.owner') }}</dt><dd><code>{{ state.registration.userId }}</code></dd></div>
        <div><dt>{{ t('p2p.enrollment.publicKey') }}</dt><dd><code>{{ state.registration.publicKey }}</code></dd></div>
        <template v-if="state.registration.kind === 'pending'">
          <div><dt>{{ t('p2p.enrollment.request') }}</dt><dd><code>{{ state.registration.requestId }}</code></dd></div>
          <div><dt>{{ t('p2p.enrollment.network') }}</dt><dd><code>{{ state.registration.networkId }}</code></dd></div>
        </template>
        <div v-else><dt>{{ t('p2p.enrollment.device') }}</dt><dd><code>{{ state.registration.deviceId }}</code></dd></div>
      </dl>
      <p v-if="state.resultUnconfirmed" role="status">{{ t('p2p.enrollment.unconfirmed') }}</p>
      <template v-if="state.registration.kind === 'pending' && state.retryRevision === state.registration.revision && !state.resultUnconfirmed">
        <p>{{ t('p2p.enrollment.absent') }}</p>
        <p v-if="!sameUser">{{ t('p2p.enrollment.loginRequired') }}</p>
        <button class="prototype-button prototype-button--primary" type="button" :disabled="busy || !canSubmit" @click="submit">
          {{ t('p2p.enrollment.submit') }}
        </button>
      </template>
    </template>
  </section>
</template>

<style scoped>
.p2p-enrollment {
  min-width: 0;
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
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
.p2p-enrollment dd { margin: 0; }
.p2p-enrollment code, .p2p-enrollment dd { overflow-wrap: anywhere; }
.p2p-enrollment :focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
</style>
