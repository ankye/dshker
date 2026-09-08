<script setup lang="ts">
import { computed, nextTick } from 'vue'
import {
  p2pAccounts as accounts,
  p2pEnrollment as enrollment,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import P2PAccountPanel from './P2PAccountPanel.vue'
import P2PEnrollmentPanel from './P2PEnrollmentPanel.vue'
import P2PPairingPanel from './P2PPairingPanel.vue'

/**
 * Network & account sub-tab (login-gated).
 *
 * Requires a selected coordinator server (chosen in the Connect tab). While
 * signed out this tab is a login page; a device that already enrolled but is
 * not logged in gets guidance that it cannot mesh yet, with a button that
 * focuses the login form. After login it composes the account, network,
 * enrollment and pairing panels. The tab never switches itself; cross-tab
 * guidance only offers the explicit entry point.
 */
const t = useTranslator()
const emit = defineEmits<{ 'navigate-connect': [] }>()

const catalog = management.catalog
const serviceId = computed(() => management.selectedServiceId.value)
const service = computed(() =>
  serviceId.value === undefined
    ? undefined
    : catalog.value?.services.find((entry) => entry.serviceId === serviceId.value)
)
const accountState = computed(() =>
  serviceId.value === undefined ? undefined : accounts.state(serviceId.value)
)
const enrollmentState = computed(() =>
  serviceId.value === undefined ? undefined : enrollment.state(serviceId.value)
)
const loggedIn = computed(
  () => accountState.value?.user !== undefined && accountState.value?.user !== null
)
/** Joined but signed out: the local device cannot mesh until it logs in. */
const joinedNotLoggedIn = computed(
  () => !loggedIn.value && enrollmentState.value?.registration !== undefined
)

async function focusLogin(): Promise<void> {
  // The login form lives inside P2PAccountPanel; focus its username field so
  // the user can type immediately instead of hunting for the form.
  await nextTick()
  if (!serviceId.value) return
  document.getElementById(`p2p-login-username-${serviceId.value}`)?.focus()
}
</script>
<template>
  <section
    class="remote-add-card p2p-network-account"
    :aria-label="t('p2p.tabs.account')"
    data-testid="p2p-network-account-panel"
  >
    <div class="remote-section-heading">
      <div>
        <h2>{{ t('p2p.tabs.account') }}</h2>
        <p>{{ t('p2p.tabs.accountDescription') }}</p>
      </div>
    </div>

    <template v-if="catalog === undefined || catalog === null || !service">
      <p>
        <strong>{{ t('p2p.accountTab.noService') }}</strong>
      </p>
      <p class="remote-form-hint">{{ t('p2p.accountTab.noServiceDescription') }}</p>
      <button
        class="prototype-button"
        type="button"
        data-testid="p2p-account-go-connect"
        @click="emit('navigate-connect')"
      >
        {{ t('p2p.accountTab.goConnect') }}
      </button>
    </template>
    <template v-else>
      <div
        v-if="joinedNotLoggedIn"
        class="p2p-mesh-gate"
        role="status"
        data-testid="p2p-account-mesh-gate"
      >
        <strong>{{ t('p2p.accountTab.meshGate') }}</strong>
        <p class="remote-form-hint">{{ t('p2p.accountTab.meshGateDescription') }}</p>
        <button
          class="prototype-button prototype-button--primary"
          type="button"
          data-testid="p2p-mesh-gate-login"
          @click="focusLogin"
        >
          {{ t('p2p.accountTab.goLogin') }}
        </button>
      </div>
      <P2PAccountPanel :service-id="service.serviceId" :display-name="service.displayName" />
      <P2PEnrollmentPanel v-if="loggedIn" :service-id="service.serviceId" />
      <P2PPairingPanel
        v-if="loggedIn"
        :key="`pairing-${service.serviceId}`"
        :service-id="service.serviceId"
        :network-id="accountState?.selectedNetworkId"
      />
    </template>
  </section>
</template>

<style scoped>
.p2p-network-account {
  min-width: 0;
}
.p2p-mesh-gate {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}
</style>
