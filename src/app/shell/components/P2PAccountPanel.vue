<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  p2pAccounts as accounts,
  p2pManagement as management
} from '@/app/domains/remote-connections'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import P2PDeviceDirectory from './P2PDeviceDirectory.vue'
import P2PAccountAuthForm from './P2PAccountAuthForm.vue'
import CopyPathButton from '@/app/shared/controls/CopyPathButton.vue'
import { P2P_NETWORK_DEVICE_LIMITS, type P2PNetworkView } from '@/shared/p2p-management'
import { p2pRefusalKind } from '@/shared/p2p-refusal'

const props = defineProps<{ serviceId: string; displayName: string }>()
const t = useTranslator()
const state = accounts.state(props.serviceId)

const selectedNetwork = computed(() =>
  state.networks?.find((network) => network.networkId === state.selectedNetworkId)
)
const networkOptions = computed<ThemedListboxOption<string>[]>(() =>
  (state.networks ?? []).map((network) => ({
    value: network.networkId,
    label: network.name
  }))
)
const directoryLoading = computed(() => management.directoryBusy(props.serviceId))
/**
 * Clock for relative times, ticked rather than read per render so every row in a
 * list agrees on "now" and the values refresh without a user action.
 *
 * The list itself is not polled: the core owns the directory, reads it at
 * startup, after a membership change and on its own interval, and announces real
 * changes, which the account domain projects. A second timer here would only
 * re-ask a question that already has one owner.
 */
const now = ref(Math.floor(Date.now() / 1000))
const clock = setInterval(() => (now.value = Math.floor(Date.now() / 1000)), 30_000)
onBeforeUnmount(() => clearInterval(clock))

// Reading the directory follows the selection: an unselected network is never
// fetched, and re-selecting the same network does not read it again.
watch(
  () => state.selectedNetworkId,
  (networkId) => {
    if (!networkId || management.busy(props.serviceId)) return
    if (state.devices[networkId] !== undefined) return
    // The first look at a network asks the core to read now, rather than showing
    // "not read yet" until the next announcement arrives: a list that only appears
    // when something else happens to refresh it reads as a list that never comes
    // out.
    void accounts.refreshDirectory(props.serviceId)
  },
  { immediate: true }
)

/**
 * Asks the core to read the coordinator again.
 *
 * The directory is maintained by the core, which announces changes; this control
 * is the explicit "now" for a user who does not want to wait for the next read.
 */
async function refreshDirectory(): Promise<void> {
  await accounts.refreshDirectory(props.serviceId)
}
const pending = computed(() => management.busy(props.serviceId))
const operation = computed(() => management.operations[props.serviceId])
const networkPending = computed(
  () =>
    pending.value &&
    (operation.value?.method === 'networks' || operation.value?.method === 'accountSelection')
)
const accountTitleKey = computed<MessageKey>(() => {
  if (state.user === null) return 'p2p.account.loginTitle'
  if (state.user) return 'p2p.account.manageTitle'
  return 'p2p.account.stateTitle'
})
const restoringAccount = computed(
  () =>
    state.user === undefined &&
    operation.value?.method === 'currentUser' &&
    (operation.value.phase === 'pending' || operation.value.phase === 'cancelling')
)
const uncertain = computed(
  () =>
    state.networkWriteUnconfirmed ||
    operation.value?.error === 'unconfirmed' ||
    operation.value?.error === 'p2p.management_result_unconfirmed' ||
    operation.value?.error === 'p2p.authorization_cleanup_failed'
)
const transientBusy = computed(() => {
  const error = operation.value?.error
  return (
    state.user !== null &&
    operation.value?.phase === 'failed' &&
    (error === 'p2p.connection_busy' || error === 'p2p.helper_busy' || error === 'p2p.service_busy')
  )
})
/** Account-operation refusals get a readable line instead of only the raw code. */
const ACCOUNT_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  'p2p.network_limit_reached': 'p2p.account.networkLimit',
  'p2p.user_conflict': 'p2p.account.userConflict',
  'p2p.invalid_user_credentials': 'p2p.account.invalidCredentials',
  // A refused input is the user's to fix, not a configuration fault. Falling
  // through to the generic message told them to check a configuration that was
  // never wrong, and showed only a bare error code.
  'p2p.invalid_request': 'p2p.account.invalidInput'
}

/**
 * Being signed out is a fact, not a failure. The coordinator reports these
 * codes whenever no session exists, which is the normal state before a login,
 * and the domain already reflects them by clearing the user. Showing them as a
 * red alert told the user to check a configuration that was never wrong.
 */
/**
 * Refusals this panel must not report as failures.
 *
 * Being signed out and having nothing registered yet are both normal states
 * before the user acts, and the domain already reflects them. Showing them as a
 * red alert told the user to check a configuration that was never wrong.
 */
const failure = computed(() => {
  const error = operation.value?.error
  if (!error) return undefined
  // Network discovery owns its own feedback region. Keeping it out of the
  // account alert prevents a slow/failed list refresh from looking like a
  // rejected login after the identity was already accepted.
  if (operation.value?.method === 'networks' || operation.value?.method === 'accountSelection')
    return undefined
  if (transientBusy.value) return undefined
  const kind = p2pRefusalKind(error)
  if (kind === 'signedOut') return undefined
  if (error === 'p2p.credential_unavailable') return undefined
  return error
})
/**
 * A readable line for every refusal, not only the four that had copy.
 *
 * A specific message wins when one exists; otherwise the classified category
 * still says something true. The raw code is available in a collapsed diagnostic
 * section, not as the primary product copy.
 */
const failureMessage = computed<MessageKey | undefined>(() => {
  const error = failure.value ?? operation.value?.error
  if (!error) return undefined
  const specific = ACCOUNT_ERROR_KEYS[error]
  if (specific) return specific
  if (uncertain.value) return 'p2p.management.unconfirmed'
  const kind = p2pRefusalKind(error)
  if (kind === 'unconfirmed') return 'p2p.management.unconfirmed'
  return `p2p.refusal.${kind}` as MessageKey
})
const removing = ref('')
/** Only a signed-in owner may remove a device: the server has no login-free removal. */
const canRemoveDevice = computed(() => Boolean(state.user))

const deletion = ref<P2PNetworkView>()
const confirmButton = ref<HTMLButtonElement>()
const manageOpen = ref(false)
const manageTrigger = ref<HTMLButtonElement>()
const createOpen = ref(false)
const createTrigger = ref<HTMLButtonElement>()
const createNameInput = ref<HTMLInputElement>()
/** Per-network target for the capacity raise; cleared once the list readback shows it. */
const limitDrafts = reactive<Record<string, number>>({})
const title = ref<HTMLHeadingElement>()
let invoker: HTMLElement | undefined
watch(
  () => state.user?.userId,
  () => {
    deletion.value = undefined
    manageOpen.value = false
    createOpen.value = false
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
  // Opening the page asks for a read now. The core maintains the list on its own,
  // but a user who opens the page is asking to see it: waiting for the next
  // announcement made a list that was already known look like it never arrived.
  void accounts.refreshDirectory(props.serviceId)
})
async function login(username: string, password: string) {
  await accounts.login(props.serviceId, username, password)
}
async function register(email: string, password: string) {
  await accounts.register(props.serviceId, email, password)
}

async function askDelete(network: P2PNetworkView, event: Event) {
  invoker = event.currentTarget as HTMLElement
  deletion.value = { ...network }
  manageOpen.value = false
  await nextTick()
  confirmButton.value?.focus()
}
async function closeDelete() {
  deletion.value = undefined
  await nextTick()
  if (invoker?.isConnected) invoker.focus()
  else if (manageTrigger.value?.isConnected) manageTrigger.value.focus()
  else title.value?.focus()
}
async function confirmDelete() {
  const target = deletion.value
  if (!target || pending.value || uncertain.value) return
  if (await accounts.deleteNetwork(props.serviceId, target.networkId)) await closeDelete()
}

/** Removes one device; the accounts domain re-reads the list afterwards. */
async function removeDevice(deviceId: string): Promise<void> {
  const network = selectedNetwork.value
  if (!network || pending.value || uncertain.value || !canRemoveDevice.value) return
  removing.value = deviceId
  // A refusal is not swallowed and not duplicated: the accounts domain records it
  // and this screen's error region shows the code, like every other write here.
  await accounts.removeDevice(props.serviceId, network.networkId, deviceId)
  removing.value = ''
}

/** Raising is only offered to the signed-in owner, and only for values above 10. */
function limitOptions(network: P2PNetworkView): number[] {
  return P2P_NETWORK_DEVICE_LIMITS.filter((limit) => limit > network.maxDevices)
}
function limitTarget(network: P2PNetworkView): number {
  return limitDrafts[network.networkId] ?? limitOptions(network)[0] ?? network.maxDevices
}
/**
 * Adapts the numeric limits to the listbox contract, which commits strings.
 *
 * The native select this replaced could not carry the application palette in its
 * popup, which the workspace design gate forbids.
 */
function limitListboxOptions(network: P2PNetworkView): ThemedListboxOption<string>[] {
  return limitOptions(network).map((limit) => ({ value: String(limit), label: String(limit) }))
}
function commitLimitDraft(network: P2PNetworkView, value: string): void {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return
  limitDrafts[network.networkId] = parsed
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

async function selectNetwork(networkId: string): Promise<void> {
  await accounts.select(props.serviceId, networkId)
}

async function openCreate(): Promise<void> {
  createOpen.value = true
  await nextTick()
  createNameInput.value?.focus()
}

async function closeCreate(): Promise<void> {
  createOpen.value = false
  await nextTick()
  if (createTrigger.value?.isConnected) createTrigger.value.focus()
}

async function submitCreate(): Promise<void> {
  const before = state.networkNameDraft
  if (!before.trim() || pending.value || uncertain.value) return
  await accounts.createNetwork(props.serviceId)
  // The domain clears this draft only after a confirmed create result. Do not
  // close the dialog on a refusal or an unconfirmed write.
  if (before !== '' && state.networkNameDraft === '') await closeCreate()
}

async function openManage(): Promise<void> {
  if (!selectedNetwork.value) return
  manageOpen.value = true
  await nextTick()
  document.querySelector<HTMLElement>('[data-testid="p2p-network-manage-dialog"] button')?.focus()
}

async function closeManage(): Promise<void> {
  manageOpen.value = false
  await nextTick()
  if (manageTrigger.value?.isConnected) manageTrigger.value.focus()
}
</script>

<template>
  <section
    class="p2p-account"
    :aria-label="`${t('p2p.account.title')} · ${displayName}`"
    data-testid="p2p-account-panel"
  >
    <div class="p2p-account-header">
      <h3 ref="title" tabindex="-1" data-testid="p2p-account-heading">
        {{ t(accountTitleKey) }}
      </h3>
      <div class="p2p-account-actions">
        <!-- Available when signed in and when the state is unknown. Confirmed
             signed out is the only case where it could merely repeat 'login
             required'. Hiding it while unknown left no control at all: no identity
             to act on and no form to sign in with, so the panel could not recover
             without restarting the app. -->
        <button
          v-if="state.user !== null"
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
    </div>
    <p
      v-if="
        pending ||
        transientBusy ||
        (operation?.phase === 'succeeded' &&
          [
            'login',
            'register',
            'createNetwork',
            'renameNetwork',
            'deleteNetwork',
            'updateNetworkLimit'
          ].includes(operation.method))
      "
      role="status"
      aria-live="polite"
    >
      <template v-if="transientBusy">{{ t('p2p.account.reading') }}</template>
      <template v-else-if="networkPending">{{ t('p2p.account.networksLoading') }}</template>
      <template v-else-if="pending">{{
        operation?.phase === 'cancelling'
          ? t('p2p.management.cancelling')
          : t('p2p.management.pending')
      }}</template>
      <template v-else-if="operation?.phase === 'succeeded'">{{
        t('p2p.management.confirmed')
      }}</template>
    </p>
    <div
      v-if="failure || state.networkWriteUnconfirmed"
      class="remote-error"
      role="alert"
      data-testid="p2p-account-error"
    >
      <p v-if="failureMessage">{{ t(failureMessage) }}</p>
      <details class="p2p-technical-details" data-testid="p2p-account-error-details">
        <summary>{{ t('p2p.account.errorDetails') }}</summary>
        <code v-if="failure ?? operation?.error">{{ failure ?? operation?.error }}</code>
      </details>
    </div>
    <p v-if="operation?.cancelError" class="remote-error" role="alert">
      {{ t('p2p.management.cancelFailed') }} <code>{{ operation.cancelError }}</code>
    </p>
    <p v-if="state.user === undefined" role="status" aria-live="polite">
      {{ restoringAccount ? t('p2p.account.restoring') : t('p2p.account.unknown') }}
    </p>
    <!-- Only a confirmed sign-out offers the credential forms. An unknown state
         is not a sign-out: showing a password field there asked for a secret the
         app could not yet use, and did it while claiming the state was unknown. -->
    <template v-if="state.user === null">
      <!-- Only a confirmed sign-out offers the credential forms. An unknown
           state is not a sign-out, and the form owns its drafts: signing in
           unmounts it, which destroys them rather than clearing them by hand. -->
      <P2PAccountAuthForm
        :service-id="serviceId"
        :username="state.usernameDraft"
        :busy="pending"
        :uncertain="uncertain"
        @login="login"
        @register="register"
        @update:username="state.usernameDraft = $event"
      />
    </template>
    <!-- Signed in is the task state: choose a network, then work with its devices. -->
    <template v-else-if="state.user">
      <div class="p2p-account-identity">
        <span class="p2p-account-identity-label">{{ t('p2p.account.user') }}</span>
        <span class="p2p-account-identity-name">{{ state.user.username }}</span>
      </div>
      <div class="p2p-networks-heading">
        <div>
          <h4>{{ t('p2p.account.networksTitle') }}</h4>
          <p>{{ t('p2p.account.networksHint') }}</p>
        </div>
        <div class="p2p-network-toolbar-actions">
          <button
            type="button"
            class="prototype-button p2p-account-refresh"
            :disabled="pending"
            @click="accounts.networks(serviceId)"
          >
            {{ t('p2p.account.readNetworks') }}
          </button>
        </div>
      </div>
      <div
        v-if="state.networks === undefined"
        class="p2p-network-load-state"
        data-testid="p2p-network-load-state"
      >
        <p v-if="networkPending" role="status" aria-live="polite">
          {{ t('p2p.account.networksLoading') }}
        </p>
        <template v-else-if="state.networksError">
          <p class="remote-error" role="alert" data-testid="p2p-network-load-error">
            {{ t('p2p.account.networksLoadFailed') }}
          </p>
          <details class="p2p-technical-details">
            <summary>{{ t('p2p.account.errorDetails') }}</summary>
            <code>{{ state.networksError }}</code>
          </details>
          <button
            type="button"
            class="prototype-button"
            :disabled="pending"
            data-testid="p2p-network-retry"
            @click="accounts.networks(serviceId)"
          >
            {{ t('p2p.account.retryNetworks') }}
          </button>
        </template>
        <p v-else>{{ t('p2p.account.networksUnknown') }}</p>
      </div>
      <template v-else>
        <div
          v-if="state.networksError"
          class="p2p-network-load-warning"
          role="alert"
          data-testid="p2p-network-load-warning"
        >
          <span>{{ t('p2p.account.networksLoadFailed') }}</span>
          <button
            type="button"
            class="prototype-button"
            :disabled="pending"
            data-testid="p2p-network-retry"
            @click="accounts.networks(serviceId)"
          >
            {{ t('p2p.account.retryNetworks') }}
          </button>
        </div>
        <div class="p2p-network-select-row">
          <label v-if="state.networks.length > 0">
            <span>{{ t('p2p.account.selectNetwork') }}</span>
            <ThemedListbox
              :model-value="state.selectedNetworkId ?? ''"
              :options="networkOptions"
              :label="t('p2p.account.selectNetwork')"
              :disabled="pending || uncertain"
              test-id="p2p-network-select"
              @update:model-value="selectNetwork($event)"
            />
          </label>
          <p v-else class="p2p-network-select-empty">{{ t('p2p.account.networksEmpty') }}</p>
          <button
            ref="createTrigger"
            type="button"
            class="prototype-button prototype-button--primary"
            :disabled="pending || uncertain"
            data-testid="p2p-network-create-open"
            @click="openCreate"
          >
            {{ t('p2p.account.create') }}
          </button>
          <button
            v-if="selectedNetwork"
            ref="manageTrigger"
            type="button"
            class="prototype-button"
            :disabled="pending || uncertain"
            data-testid="p2p-network-manage-open"
            @click="openManage"
          >
            {{ t('p2p.account.manageNetwork') }}
          </button>
        </div>
        <p v-if="state.networks.length > 0 && !selectedNetwork">
          {{ t('p2p.account.selectRequired') }}
        </p>
        <div
          v-if="selectedNetwork"
          class="p2p-network-summary"
          data-testid="p2p-selected-network-summary"
        >
          <div>
            <span class="p2p-network-summary-label">{{ t('p2p.account.currentNetwork') }}</span>
            <strong>{{ selectedNetwork.name }}</strong>
          </div>
          <div>
            <span class="p2p-network-summary-label">{{ t('p2p.account.networkId') }}</span>
            <code data-testid="p2p-network-id">{{ selectedNetwork.networkId }}</code>
            <CopyPathButton :value="selectedNetwork.networkId" />
          </div>
          <span class="p2p-network-summary-limit">
            {{ selectedNetwork.maxDevices }} {{ t('p2p.account.devicesUnit') }}
          </span>
        </div>
        <P2PDeviceDirectory
          v-if="selectedNetwork"
          :devices="state.devices[selectedNetwork.networkId]"
          :max-devices="selectedNetwork.maxDevices"
          :failed="state.devicesFailed[selectedNetwork.networkId] === true"
          :loading="directoryLoading"
          :now="now"
          :removing="removing"
          :can-remove="canRemoveDevice"
          @remove="removeDevice"
          @refresh="refreshDirectory"
        />
      </template>
      <section
        v-if="createOpen"
        class="p2p-network-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('p2p.account.create')"
        data-testid="p2p-network-create-dialog"
        @keydown.esc="closeCreate"
      >
        <div class="p2p-dialog-header">
          <h4>{{ t('p2p.account.create') }}</h4>
          <button
            type="button"
            class="prototype-button"
            data-testid="p2p-network-create-close"
            @click="closeCreate"
          >
            {{ t('p2p.account.closeDialog') }}
          </button>
        </div>
        <form @submit.prevent="submitCreate">
          <fieldset :disabled="pending || uncertain" class="p2p-account-fields">
            <label>
              <span>{{ t('p2p.account.newName') }}</span>
              <input ref="createNameInput" v-model="state.networkNameDraft" required />
            </label>
            <div class="p2p-dialog-actions">
              <button type="submit" class="prototype-button prototype-button--primary">
                {{ t('p2p.account.create') }}
              </button>
              <button type="button" class="prototype-button" @click="closeCreate">
                {{ t('p2p.account.closeDialog') }}
              </button>
            </div>
          </fieldset>
        </form>
      </section>
      <section
        v-if="manageOpen && selectedNetwork"
        class="p2p-network-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('p2p.account.manageNetwork')"
        data-testid="p2p-network-manage-dialog"
        @keydown.esc="closeManage"
      >
        <div class="p2p-dialog-header">
          <h4>{{ t('p2p.account.manageNetwork') }} · {{ selectedNetwork.name }}</h4>
          <button type="button" class="prototype-button" @click="closeManage">
            {{ t('p2p.account.closeDialog') }}
          </button>
        </div>
        <form @submit.prevent="accounts.renameNetwork(serviceId, selectedNetwork!.networkId)">
          <fieldset :disabled="pending || uncertain" class="p2p-account-fields">
            <label>
              <span>{{ t('p2p.account.newName') }}</span>
              <input
                :value="
                  state.renameDrafts[selectedNetwork.networkId] === undefined
                    ? selectedNetwork.name
                    : state.renameDrafts[selectedNetwork.networkId]
                "
                required
                @input="
                  state.renameDrafts[selectedNetwork.networkId] = (
                    $event.target as HTMLInputElement
                  ).value
                "
              />
            </label>
            <button
              type="submit"
              class="prototype-button"
              :disabled="state.renameDrafts[selectedNetwork.networkId] === undefined"
            >
              {{ t('p2p.account.rename') }}
            </button>
          </fieldset>
        </form>
        <div
          class="p2p-network-capacity"
          :data-owned="selectedNetwork.userId === state.user?.userId"
        >
          <p data-testid="p2p-network-limit">
            {{ t('p2p.account.capacity') }}: <code>{{ selectedNetwork.maxDevices }}</code>
          </p>
          <p
            v-if="selectedNetwork.userId === state.user?.userId && selectedNetwork.maxDevices >= 30"
            class="remote-form-hint"
          >
            {{ t('p2p.account.capacityMaxed') }}
          </p>
          <div
            v-else-if="
              selectedNetwork.userId === state.user?.userId &&
              limitOptions(selectedNetwork).length > 0
            "
            class="p2p-limit-control"
          >
            <label>
              <span>{{ t('p2p.account.raiseTo') }}</span>
              <ThemedListbox
                :model-value="String(limitTarget(selectedNetwork))"
                :options="limitListboxOptions(selectedNetwork)"
                :label="t('p2p.account.raiseTo')"
                :disabled="pending || uncertain"
                test-id="p2p-limit"
                @update:model-value="commitLimitDraft(selectedNetwork, $event)"
              />
            </label>
            <button
              class="prototype-button"
              type="button"
              data-testid="p2p-limit-save"
              :disabled="pending || uncertain"
              @click="saveLimit(selectedNetwork)"
            >
              {{ t('p2p.account.saveLimit') }}
            </button>
          </div>
        </div>
        <div class="p2p-network-identity">
          <span class="p2p-network-identity-label">{{ t('p2p.account.networkId') }}</span>
          <code class="p2p-network-identity-value">{{ selectedNetwork.networkId }}</code>
          <CopyPathButton :value="selectedNetwork.networkId" />
          <p class="p2p-network-identity-hint">{{ t('p2p.account.networkIdHint') }}</p>
        </div>
        <div class="p2p-network-danger">
          <span>{{ t('p2p.account.deleteWarning') }}</span>
          <button
            type="button"
            class="prototype-button prototype-button--danger"
            :disabled="pending || uncertain"
            @click="askDelete(selectedNetwork, $event)"
          >
            {{ t('p2p.account.delete') }}
          </button>
        </div>
        <div class="p2p-dialog-actions">
          <button type="button" class="prototype-button" @click="closeManage">
            {{ t('p2p.account.closeDialog') }}
          </button>
        </div>
      </section>
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

<style scoped src="./P2PAccountPanel.css"></style>
