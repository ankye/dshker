<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  p2pManagement as domain,
  p2pServiceEditor as editor
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { P2PServiceView } from '@/shared/p2p-management'
import P2PServiceEditorPanel from './P2PServiceEditorPanel.vue'

/**
 * P2P coordinator/server configuration (Connect tab).
 *
 * This is the login-free half of P2P management: the endpoint list, add and
 * edit forms, plus choosing which server the login-gated Network & account
 * tab operates on. Account, enrollment and pairing panels live in
 * P2PNetworkAccountPanel and are never mounted here.
 */
const t = useTranslator()
const state = computed(() => domain.operations.catalog)
const catalog = domain.catalog
const busy = computed(() => domain.busy('catalog'))
const draft = domain.serviceDraft
const selectedService = computed(() =>
  catalog.value?.services.find((service) => service.serviceId === domain.selectedServiceId.value)
)
const uncertain = computed(
  () =>
    state.value?.error === 'unconfirmed' ||
    state.value?.error === 'p2p.management_result_unconfirmed'
)
onMounted(() => {
  void domain.readCatalog()
})

function choose(service: P2PServiceView): void {
  domain.selectedServiceId.value = service.serviceId
}
function edit(service: P2PServiceView): void {
  if (!catalog.value) return
  editor.open(service, catalog.value.revision)
}
</script>

<template>
  <section
    class="remote-add-card p2p-management"
    aria-labelledby="p2p-management-title"
    data-testid="p2p-management"
  >
    <div class="remote-section-heading">
      <div>
        <h2 id="p2p-management-title">{{ t('p2p.management.title') }}</h2>
        <p>{{ t('p2p.management.description') }}</p>
      </div>
      <button class="prototype-button" type="button" :disabled="busy" @click="domain.readCatalog()">
        {{ t('p2p.management.readback') }}
      </button>
    </div>

    <div role="status" aria-live="polite" class="p2p-feedback">
      <template v-if="busy">
        <span>{{
          state?.phase === 'cancelling'
            ? t('p2p.management.cancelling')
            : t('p2p.management.pending')
        }}</span>
        <button
          v-if="state?.phase === 'pending'"
          type="button"
          class="prototype-button"
          @click="domain.cancel('catalog')"
        >
          {{ t('p2p.management.cancel') }}
        </button>
      </template>
      <span v-else-if="state?.phase === 'succeeded'">{{ t('p2p.management.confirmed') }}</span>
    </div>
    <p v-if="state?.error" role="alert" class="remote-error">
      {{ uncertain ? t('p2p.management.unconfirmed') : t('p2p.management.failed') }}
      <code>{{ state.error }}</code>
    </p>
    <p v-if="state?.cancelError" role="alert" class="remote-error">
      {{ t('p2p.management.cancelFailed') }} <code>{{ state.cancelError }}</code>
    </p>

    <p v-if="catalog === undefined">{{ t('p2p.management.notLoaded') }}</p>
    <div v-else-if="catalog === null">
      <p>{{ t('p2p.management.disabled') }}</p>
      <button
        class="prototype-button prototype-button--primary"
        type="button"
        :disabled="busy"
        @click="domain.enable()"
      >
        {{ t('p2p.management.enable') }}
      </button>
    </div>
    <template v-else>
      <p v-if="catalog.services.length === 0">{{ t('p2p.management.empty') }}</p>
      <ul v-else class="p2p-services">
        <li v-for="service in catalog.services" :key="service.serviceId">
          <strong>{{ service.displayName }}</strong>
          <dl>
            <dt>{{ t('p2p.management.https') }}</dt>
            <dd>{{ service.httpsOrigin }}</dd>
            <dt>{{ t('p2p.management.wss') }}</dt>
            <dd>{{ service.wssUrl }}</dd>
            <dt>{{ t('p2p.management.stun') }}</dt>
            <dd>{{ service.stunAddress }}</dd>
            <dt>{{ t('p2p.management.identity') }}</dt>
            <dd>
              <code>{{ service.serviceId }}</code>
            </dd>
          </dl>
          <p>{{ t('p2p.management.notConnected') }}</p>
          <div class="p2p-row-actions">
            <button
              class="prototype-button"
              type="button"
              :disabled="catalog.forgottenServiceIds.includes(service.serviceId)"
              @click="choose(service)"
            >
              {{ t('p2p.account.manage') }}
            </button>
            <button
              class="prototype-button"
              type="button"
              :disabled="catalog.forgottenServiceIds.includes(service.serviceId)"
              @click="edit(service)"
            >
              {{ t('p2p.management.editService') }}
            </button>
          </div>
          <p v-if="selectedService?.serviceId === service.serviceId" class="remote-form-hint">
            {{ service.displayName }} · {{ t('p2p.management.manageHint') }}
          </p>
        </li>
      </ul>
      <P2PServiceEditorPanel />
      <form @submit.prevent="domain.addService()" data-testid="p2p-service-form">
        <fieldset :disabled="busy" class="p2p-service-fields">
          <legend>{{ t('p2p.management.addService') }}</legend>
          <div class="remote-add-form">
            <label
              ><span>{{ t('remote.field.name') }}</span
              ><input v-model="draft.displayName" required autocomplete="off"
            /></label>
            <label
              ><span>{{ t('p2p.management.https') }}</span
              ><input v-model="draft.httpsOrigin" required autocomplete="off" spellcheck="false"
            /></label>
            <label
              ><span>{{ t('p2p.management.wss') }}</span
              ><input v-model="draft.wssUrl" required autocomplete="off" spellcheck="false"
            /></label>
            <label
              ><span>{{ t('p2p.management.stun') }}</span
              ><input v-model="draft.stunAddress" required autocomplete="off" spellcheck="false"
            /></label>
            <button class="prototype-button prototype-button--primary" type="submit">
              {{ t('p2p.management.verifyAdd') }}
            </button>
          </div>
        </fieldset>
        <p class="remote-form-hint">{{ t('p2p.management.addHint') }}</p>
      </form>
    </template>
  </section>
</template>

<style scoped>
.p2p-management {
  min-width: 0;
}
.p2p-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.p2p-service-fields {
  border: 0;
  padding: 0;
  margin: var(--space-4) 0 0;
  min-width: 0;
}
.p2p-services {
  list-style: none;
  padding: 0;
}
.p2p-services li {
  padding-block: var(--space-3);
}
.p2p-services dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 3fr);
  gap: var(--space-2);
}
.p2p-services dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.p2p-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.remote-error code {
  overflow-wrap: anywhere;
}
</style>
