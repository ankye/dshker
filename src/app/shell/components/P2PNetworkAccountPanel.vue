<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  p2pAccounts as accounts,
  p2pEnrollment as enrollment,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import P2PAccountPanel from './P2PAccountPanel.vue'
import P2PJoinPanel from './P2PJoinPanel.vue'
import P2PAccountAuthForm from './P2PAccountAuthForm.vue'

/**
 * Network & account sub-tab (login-gated).
 *
 * Requires a selected coordinator server (provisioned by the built-in service).
 * The full 「我的网络」 identity/membership card lives here, including its
 * login-free join flow; the Connect tab only links here from its compact join
 * entry. The tab never switches itself or bounces the user back to Connect.
 * After login it composes the account/network workspace only; enrollment and
 * explicit pairing workflows remain available as domain capabilities but are
 * not repeated in this default page.
 */
const t = useTranslator()
const unavailableUsername = ref('')

function unavailableLogin(): void {}
function unavailableRegister(): void {}

// The built-in official server is provisioned and selected automatically, so
// this tab works whether the user visited Connect first or not.
onMounted(() => {
  void management.ensureBuiltinService()
})

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
</script>
<template>
  <section
    class="remote-add-card p2p-network-account"
    :aria-label="t('p2p.tabs.account')"
    data-testid="p2p-network-account-panel"
  >
    <!-- Keep the local identity card mounted even when the coordinator is still
         loading or unavailable. Device name/ID are local facts and should not
         disappear just because account management cannot run yet. -->
    <P2PJoinPanel />

    <template v-if="catalog === undefined || catalog === null || !service">
      <div class="p2p-service-gate" role="status" data-testid="p2p-account-service-gate">
        <p>
          <strong>{{ t('p2p.accountTab.noService') }}</strong>
        </p>
        <p class="remote-form-hint">{{ t('p2p.accountTab.noServiceDescription') }}</p>
        <h3 class="p2p-login-register-heading">{{ t('p2p.accountTab.loginRegister') }}</h3>
        <P2PAccountAuthForm
          :username="unavailableUsername"
          :busy="true"
          :uncertain="false"
          :disabled="true"
          @login="unavailableLogin"
          @register="unavailableRegister"
          @update:username="unavailableUsername = $event"
        />
      </div>
    </template>
    <template v-else>
      <div
        v-if="joinedNotLoggedIn"
        class="p2p-mesh-gate"
        role="status"
        data-testid="p2p-account-mesh-gate"
      >
        <strong>{{ t('p2p.accountTab.meshGate') }}</strong>
      </div>
      <P2PAccountPanel
        :key="service.serviceId"
        :service-id="service.serviceId"
        :display-name="service.displayName"
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
