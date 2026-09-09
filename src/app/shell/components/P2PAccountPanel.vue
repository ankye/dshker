<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  p2pAccounts as accounts,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import { P2P_NETWORK_DEVICE_LIMITS, type P2PNetworkView } from '@/shared/p2p-management'

const props = defineProps<{ serviceId: string; displayName: string }>()
const t = useTranslator()
const state = accounts.state(props.serviceId)
const password = ref('')
/** Registration drafts stay local to the panel, including its own email field:
 * sharing one draft let typing in one form silently rewrite the other. */
const registerEmail = ref('')
const registerPassword = ref('')
const registerConfirm = ref('')
/** Signed out shows one form at a time; the other is one link away. */
const mode = ref<'login' | 'register'>('login')
const pending = computed(() => management.busy(props.serviceId))
const operation = computed(() => management.operations[props.serviceId])
const uncertain = computed(
  () =>
    state.networkWriteUnconfirmed ||
    operation.value?.error === 'unconfirmed' ||
    operation.value?.error === 'p2p.management_result_unconfirmed' ||
    operation.value?.error === 'p2p.authorization_cleanup_failed'
)
/** Optional confirmation must match before a register submit is allowed. */
const registerMismatch = computed(
  () => registerConfirm.value !== '' && registerConfirm.value !== registerPassword.value
)

/** Account-operation refusals get a readable line instead of only the raw code. */
const ACCOUNT_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  'p2p.network_limit_reached': 'p2p.account.networkLimit',
  'p2p.user_conflict': 'p2p.account.userConflict'
}
const accountErrorKey = computed<MessageKey | undefined>(() => {
  const error = operation.value?.error
  return error ? ACCOUNT_ERROR_KEYS[error] : undefined
})
/**
 * Being signed out is a fact, not a failure. The coordinator reports these
 * codes whenever no session exists, which is the normal state before a login,
 * and the domain already reflects them by clearing the user. Showing them as a
 * red alert told the user to check a configuration that was never wrong.
 */
const SIGNED_OUT_CODES: readonly string[] = [
  'p2p.user_login_required',
  'p2p.user_session_expired',
  'p2p.user_unauthorized'
]
const failure = computed(() => {
  const error = operation.value?.error
  if (!error || SIGNED_OUT_CODES.includes(error)) return undefined
  return error
})
const deletion = ref<P2PNetworkView>()
const confirmButton = ref<HTMLButtonElement>()
/** Per-network target for the capacity raise; cleared once the list readback shows it. */
const limitDrafts = reactive<Record<string, number>>({})
const title = ref<HTMLHeadingElement>()
let invoker: HTMLElement | undefined
watch(
  () => state.user?.userId,
  () => {
    deletion.value = undefined
    password.value = ''
    registerEmail.value = ''
    registerPassword.value = ''
    registerConfirm.value = ''
    mode.value = 'login'
  }
)
watch(
  () => state.networks,
  (networks) => {
    if (
      networks &&
      deletion.value &&
      !networks.some((network) => network.networkId === deletion.value?.networkId)
    )
      void closeDelete()
  }
)

onMounted(() => {
  void accounts.currentUser(props.serviceId)
})
onBeforeUnmount(() => {
  password.value = ''
  registerEmail.value = ''
  registerPassword.value = ''
  registerConfirm.value = ''
})
async function login() {
  const supplied = password.value
  password.value = ''
  await accounts.login(props.serviceId, state.usernameDraft, supplied)
}
async function register() {
  if (registerMismatch.value) return
  const supplied = registerPassword.value
  registerPassword.value = ''
  registerConfirm.value = ''
  await accounts.register(props.serviceId, registerEmail.value, supplied)
}

/** Switching forms discards only the secrets typed into the abandoned one. */
function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  password.value = ''
  registerPassword.value = ''
  registerConfirm.value = ''
}
async function askDelete(network: P2PNetworkView, event: Event) {
  invoker = event.currentTarget as HTMLElement
  deletion.value = { ...network }
  await nextTick()
  confirmButton.value?.focus()
}
async function closeDelete() {
  deletion.value = undefined
  await nextTick()
  if (invoker?.isConnected) invoker.focus()
  else title.value?.focus()
}
async function confirmDelete() {
  const target = deletion.value
  if (!target || pending.value || uncertain.value) return
  if (await accounts.deleteNetwork(props.serviceId, target.networkId)) await closeDelete()
}

/** Raising is only offered to the signed-in owner, and only for values above 10. */
function limitOptions(network: P2PNetworkView): number[] {
  return P2P_NETWORK_DEVICE_LIMITS.filter((limit) => limit > network.maxDevices)
}
function limitTarget(network: P2PNetworkView): number {
  return limitDrafts[network.networkId] ?? limitOptions(network)[0] ?? network.maxDevices
}
async function saveLimit(network: P2PNetworkView): Promise<void> {
  const target = limitDrafts[network.networkId] ?? limitOptions(network)[0]
  if (!target || pending.value || uncertain.value) return
  await accounts.raiseNetworkLimit(props.serviceId, network.networkId, target)
  // Confirmed readback replaces the row; the draft is then obsolete.
  if (
    state.networks?.some(
      (entry) => entry.networkId === network.networkId && entry.maxDevices >= target
    )
  )
    delete limitDrafts[network.networkId]
}
</script>

<template>
  <section class="p2p-account" :aria-label="t('p2p.account.title')" data-testid="p2p-account-panel">
    <h3 ref="title" tabindex="-1">{{ t('p2p.account.title') }} · {{ displayName }}</h3>
    <p>
      <code>{{ serviceId }}</code>
    </p>
    <div class="p2p-account-actions">
      <!-- Re-reading the signed-in user is only meaningful once there is one;
           signed out it could only repeat 'login required'. -->
      <button
        v-if="state.user"
        type="button"
        class="prototype-button"
        :disabled="pending"
        data-testid="p2p-account-read-user"
        @click="accounts.currentUser(serviceId)"
      >
        {{ t('p2p.account.readUser') }}
      </button>
      <button
        v-if="state.user"
        type="button"
        class="prototype-button"
        :disabled="pending"
        @click="accounts.logout(serviceId)"
      >
        {{ t('p2p.account.logout') }}
      </button>
      <button
        v-if="operation?.phase === 'pending'"
        type="button"
        class="prototype-button"
        @click="management.cancel(serviceId)"
      >
        {{ t('p2p.management.cancel') }}
      </button>
    </div>
    <p role="status" aria-live="polite">
      <template v-if="pending">{{
        operation?.phase === 'cancelling'
          ? t('p2p.management.cancelling')
          : t('p2p.management.pending')
      }}</template>
      <template v-else-if="operation?.phase === 'succeeded'">{{
        t('p2p.management.confirmed')
      }}</template>
    </p>
    <p
      v-if="failure || state.networkWriteUnconfirmed"
      class="remote-error"
      role="alert"
      data-testid="p2p-account-error"
    >
      <template v-if="accountErrorKey">{{ t(accountErrorKey) }}</template>
      <template v-else>{{
        uncertain ? t('p2p.management.unconfirmed') : t('p2p.management.failed')
      }}</template>
      <code>{{ failure ?? operation?.error }}</code>
    </p>
    <p v-if="operation?.cancelError" class="remote-error" role="alert">
      {{ t('p2p.management.cancelFailed') }} <code>{{ operation.cancelError }}</code>
    </p>
    <p v-if="state.user === undefined">{{ t('p2p.account.unknown') }}</p>
    <template v-if="!state.user">
      <form v-if="mode === 'login'" data-testid="p2p-login-form" @submit.prevent="login">
        <fieldset
          :disabled="pending || uncertain"
          class="p2p-account-fields p2p-account-fields--stacked"
        >
          <legend>{{ t('p2p.account.login') }}</legend>
          <label
            ><span>{{ t('p2p.account.email') }}</span
            ><input
              :id="`p2p-login-email-${serviceId}`"
              v-model="state.usernameDraft"
              type="email"
              required
              autocomplete="username"
              spellcheck="false"
          /></label>
          <label
            ><span>{{ t('p2p.account.password') }}</span
            ><input v-model="password" type="password" required autocomplete="current-password"
          /></label>
          <button type="submit" class="prototype-button prototype-button--primary">
            {{ t('p2p.account.login') }}
          </button>
        </fieldset>
        <p>{{ t('p2p.account.passwordHint') }}</p>
        <p class="p2p-account-switch">
          <span>{{ t('p2p.account.noAccount') }}</span>
          <button
            type="button"
            class="p2p-account-switch-link"
            data-testid="p2p-account-switch-register"
            @click="switchMode('register')"
          >
            {{ t('p2p.account.register') }}
          </button>
        </p>
      </form>
      <form v-else data-testid="p2p-register-form" @submit.prevent="register">
        <fieldset
          :disabled="pending || uncertain"
          class="p2p-account-fields p2p-account-fields--stacked"
        >
          <legend>{{ t('p2p.account.register') }}</legend>
          <label
            ><span>{{ t('p2p.account.email') }}</span
            ><input
              :id="`p2p-register-email-${serviceId}`"
              v-model="registerEmail"
              type="email"
              required
              autocomplete="email"
              spellcheck="false"
              data-testid="p2p-register-email"
          /></label>
          <label
            ><span>{{ t('p2p.account.password') }}</span
            ><input
              v-model="registerPassword"
              type="password"
              required
              autocomplete="new-password"
              data-testid="p2p-register-password"
          /></label>
          <label
            ><span>{{ t('p2p.account.confirmPassword') }}</span
            ><input
              v-model="registerConfirm"
              type="password"
              autocomplete="new-password"
              data-testid="p2p-register-confirm"
          /></label>
          <button
            type="submit"
            class="prototype-button prototype-button--primary"
            :disabled="registerMismatch"
          >
            {{ t('p2p.account.register') }}
          </button>
        </fieldset>
        <p>{{ t('p2p.account.registerHint') }}</p>
        <p class="p2p-account-switch">
          <span>{{ t('p2p.account.haveAccount') }}</span>
          <button
            type="button"
            class="p2p-account-switch-link"
            data-testid="p2p-account-switch-login"
            @click="switchMode('login')"
          >
            {{ t('p2p.account.login') }}
          </button>
        </p>
      </form>
    </template>
    <template v-else>
      <p>
        {{ t('p2p.account.user') }}: {{ state.user.username }} ·
        <code>{{ state.user.userId }}</code>
      </p>
      <button
        type="button"
        class="prototype-button"
        :disabled="pending"
        @click="accounts.networks(serviceId)"
      >
        {{ t('p2p.account.readNetworks') }}
      </button>
      <p v-if="state.networks === undefined">{{ t('p2p.account.networksUnknown') }}</p>
      <template v-else>
        <p v-if="state.networks.length === 0">{{ t('p2p.account.networksEmpty') }}</p>
        <ul class="p2p-network-list">
          <li v-for="network in state.networks" :key="network.networkId">
            <label
              ><input
                type="radio"
                :name="`network-${serviceId}`"
                :checked="state.selectedNetworkId === network.networkId"
                :disabled="pending || uncertain"
                @change="accounts.select(serviceId, network.networkId)"
              />
              {{ network.name }}</label
            >
            <p>
              <code>{{ network.networkId }}</code>
            </p>
            <form @submit.prevent="accounts.renameNetwork(serviceId, network.networkId)">
              <fieldset :disabled="pending || uncertain" class="p2p-account-fields">
                <label
                  ><span>{{ t('p2p.account.newName') }}</span
                  ><input
                    :value="
                      state.renameDrafts[network.networkId] === undefined
                        ? network.name
                        : state.renameDrafts[network.networkId]
                    "
                    required
                    @input="
                      state.renameDrafts[network.networkId] = (
                        $event.target as HTMLInputElement
                      ).value
                    "
                /></label>
                <button
                  type="submit"
                  class="prototype-button"
                  :disabled="state.renameDrafts[network.networkId] === undefined"
                >
                  {{ t('p2p.account.rename') }}
                </button>
                <button
                  type="button"
                  class="prototype-button prototype-button--danger"
                  @click="askDelete(network, $event)"
                >
                  {{ t('p2p.account.delete') }}
                </button>
              </fieldset>
            </form>
            <div class="p2p-network-capacity" :data-owned="network.userId === state.user?.userId">
              <p data-testid="p2p-network-limit">
                {{ t('p2p.account.capacity') }}: <code>{{ network.maxDevices }}</code>
              </p>
              <p
                v-if="network.userId === state.user?.userId && network.maxDevices >= 30"
                class="remote-form-hint"
              >
                {{ t('p2p.account.capacityMaxed') }}
              </p>
              <div
                v-else-if="
                  network.userId === state.user?.userId && limitOptions(network).length > 0
                "
                class="p2p-limit-control"
              >
                <label>
                  <span>{{ t('p2p.account.raiseTo') }}</span>
                  <select
                    :value="limitTarget(network)"
                    data-testid="p2p-limit-select"
                    :disabled="pending || uncertain"
                    @change="
                      limitDrafts[network.networkId] = Number(
                        ($event.target as HTMLSelectElement).value
                      )
                    "
                  >
                    <option v-for="option in limitOptions(network)" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                </label>
                <button
                  class="prototype-button"
                  type="button"
                  data-testid="p2p-limit-save"
                  :disabled="pending || uncertain"
                  @click="saveLimit(network)"
                >
                  {{ t('p2p.account.saveLimit') }}
                </button>
              </div>
            </div>
          </li>
        </ul>
        <p v-if="state.selectedNetworkId">
          {{ t('p2p.account.selected') }}: <code>{{ state.selectedNetworkId }}</code>
        </p>
        <p v-else>{{ t('p2p.account.selectRequired') }}</p>
        <form @submit.prevent="accounts.createNetwork(serviceId)">
          <fieldset :disabled="pending || uncertain" class="p2p-account-fields">
            <label
              ><span>{{ t('p2p.account.newName') }}</span
              ><input v-model="state.networkNameDraft" required
            /></label>
            <button type="submit" class="prototype-button">{{ t('p2p.account.create') }}</button>
          </fieldset>
        </form>
      </template>
    </template>
    <section
      v-if="deletion"
      class="p2p-delete-confirm"
      :aria-label="t('p2p.account.deleteConfirm')"
    >
      <h4>{{ t('p2p.account.deleteConfirm') }}</h4>
      <p>
        {{ deletion.name }} · <code>{{ deletion.networkId }}</code>
      </p>
      <p>{{ t('p2p.account.deleteWarning') }}</p>
      <button
        ref="confirmButton"
        type="button"
        class="prototype-button prototype-button--danger"
        :disabled="pending || uncertain"
        @click="confirmDelete"
      >
        {{ t('p2p.account.delete') }}
      </button>
      <button type="button" class="prototype-button" :disabled="pending" @click="closeDelete">
        {{ t('p2p.account.keep') }}
      </button>
    </section>
  </section>
</template>

<style scoped>
.p2p-account {
  min-width: 0;
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-4);
}
.p2p-account code {
  overflow-wrap: anywhere;
}
.p2p-account-actions,
.p2p-account-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: end;
}
.p2p-account-fields {
  border: 0;
  padding: 0;
  margin: var(--space-3) 0;
  min-width: 0;
}
.p2p-account-fields label {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  flex: 1 1 12rem;
}
/* Credential forms read top to bottom: one field per row at a legible width,
   unlike the inline rename and create-network forms that share the base class. */
.p2p-account-fields--stacked {
  display: grid;
  gap: var(--space-3);
  align-items: stretch;
  max-width: 22rem;
}
.p2p-account-fields--stacked label {
  flex: none;
}
.p2p-account-fields--stacked button {
  justify-self: start;
  margin-top: var(--space-1);
}
.p2p-account-fields input {
  width: 100%;
  min-height: var(--size-control-md);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
}
.p2p-account input:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 1px;
}
.p2p-account-switch {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.p2p-account-switch-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.p2p-account-switch-link:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.p2p-network-list {
  list-style: none;
  padding: 0;
}
.p2p-network-list li {
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
.p2p-delete-confirm {
  padding: var(--space-4);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
}
.p2p-network-capacity {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--color-border);
}
.p2p-network-capacity p {
  margin: 0;
}
.p2p-limit-control {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
.p2p-limit-control label {
  display: grid;
  gap: var(--space-1);
}
</style>
