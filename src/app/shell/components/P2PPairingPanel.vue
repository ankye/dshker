<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  p2pConnections as connections,
  p2pManagement as management,
  p2pPairing as pairing,
  p2pWorkReconciliation as work
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import type { P2PConnectionView, P2PPairView } from '@/shared/p2p-management'
import P2PRemoteProjectsPanel from './P2PRemoteProjectsPanel.vue'

const props = defineProps<{ serviceId: string; networkId: string | undefined }>()
const t = useTranslator()
const state = pairing.state(props.serviceId)
const pending = computed(() => management.busy(props.serviceId))
const operation = computed(() => management.operations[props.serviceId])
const uncertain = computed(
  () =>
    state.resultUnconfirmed ||
    operation.value?.error === 'unconfirmed' ||
    operation.value?.error === 'p2p.management_result_unconfirmed'
)
const mismatch = computed(() => operation.value?.error === 'p2p.pair_fingerprint_mismatch')
/** Writes need a selected network; reads never do. */
const canWrite = computed(() => !pending.value && !uncertain.value && props.networkId !== undefined)
const revoking = ref<P2PPairView>()
const confirmButton = ref<HTMLButtonElement>()
const reviewHeading = ref<HTMLHeadingElement>()
const title = ref<HTMLHeadingElement>()
let invoker: HTMLElement | undefined

const live = computed(() => connections.state)

onMounted(() => {
  void pairing.read(props.serviceId)
  void connections.read()
})

const stageLabels: Record<P2PConnectionView['stage'], MessageKey> = {
  punching: 'p2p.connection.stagePunching',
  'starting-runtime': 'p2p.connection.stageStarting',
  ready: 'p2p.connection.stageReady',
  failed: 'p2p.connection.stageFailed',
  disconnected: 'p2p.connection.stageDisconnected'
}

const stateLabels: Record<P2PPairView['state'], MessageKey> = {
  pending_target_approval: 'p2p.pairing.statePendingTarget',
  pending_initiator_confirmation: 'p2p.pairing.statePendingInitiator',
  active: 'p2p.pairing.stateActive',
  revoked: 'p2p.pairing.stateRevoked',
  expired: 'p2p.pairing.stateExpired'
}

/** Approval is only offered while the pair is still pending. */
function awaitingConfirmation(pair: P2PPairView): boolean {
  return pair.state === 'pending_target_approval' || pair.state === 'pending_initiator_confirmation'
}

function expiry(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}

async function review(pair: P2PPairView, event: Event) {
  invoker = event.currentTarget as HTMLElement
  await pairing.review(props.serviceId, pair.pairId)
  await nextTick()
  reviewHeading.value?.focus()
}

async function closeReview() {
  pairing.closeReview(props.serviceId)
  await nextTick()
  if (invoker?.isConnected) invoker.focus()
  else title.value?.focus()
}

async function askRevoke(pair: P2PPairView, event: Event) {
  invoker = event.currentTarget as HTMLElement
  revoking.value = { ...pair }
  await nextTick()
  confirmButton.value?.focus()
}

async function closeRevoke() {
  revoking.value = undefined
  await nextTick()
  if (invoker?.isConnected) invoker.focus()
  else title.value?.focus()
}

async function confirmRevoke() {
  const target = revoking.value
  if (!target || !canWrite.value) return
  await pairing.revoke(props.serviceId, target.pairId)
  await closeRevoke()
}
</script>

<template>
  <section class="p2p-pairing" :aria-label="t('p2p.pairing.title')" data-testid="p2p-pairing-panel">
    <div class="remote-section-heading">
      <div>
        <h3 ref="title" tabindex="-1">{{ t('p2p.pairing.title') }}</h3>
        <p>{{ t('p2p.pairing.description') }}</p>
      </div>
      <button
        type="button"
        class="prototype-button"
        :disabled="pending"
        data-testid="p2p-pairing-read"
        @click="pairing.read(serviceId)"
      >
        {{ t('p2p.pairing.read') }}
      </button>
    </div>

    <p v-if="uncertain" role="alert" class="remote-error">{{ t('p2p.pairing.unconfirmed') }}</p>
    <p v-if="mismatch" role="alert" class="remote-error">{{ t('p2p.pairing.mismatch') }}</p>
    <p v-if="live.resultUnconfirmed" role="alert" class="remote-error">
      {{ t('p2p.connection.unconfirmed') }}
    </p>
    <p v-if="live.helperError" role="alert" class="remote-error">
      {{ t('p2p.connection.helperError') }} <code>{{ live.helperError }}</code>
    </p>

    <!-- Invite creation: the code is a one-time secret, so it gets its own region. -->
    <div class="p2p-pairing-invite">
      <button
        type="button"
        class="prototype-button"
        :disabled="!canWrite"
        data-testid="p2p-create-invite"
        @click="networkId && pairing.createInvite(serviceId, networkId)"
      >
        {{ t('p2p.pairing.createInvite') }}
      </button>
      <p v-if="!networkId" class="remote-form-hint">{{ t('p2p.account.selectRequired') }}</p>
      <div v-if="state.issuedInvite" class="p2p-pairing-code" role="group">
        <p role="alert">{{ t('p2p.pairing.inviteIssued') }}</p>
        <dl>
          <dt>{{ t('p2p.pairing.inviteCode') }}</dt>
          <dd>
            <code data-testid="p2p-invite-code">{{ state.issuedInvite.code }}</code>
          </dd>
          <dt>{{ t('p2p.pairing.inviteExpires') }}</dt>
          <dd>{{ expiry(state.issuedInvite.expiresAt) }}</dd>
        </dl>
        <button type="button" class="prototype-button" @click="pairing.dismissInvite(serviceId)">
          {{ t('p2p.pairing.dismissInvite') }}
        </button>
      </div>
    </div>

    <form
      class="p2p-pairing-accept"
      data-testid="p2p-accept-invite-form"
      @submit.prevent="networkId && pairing.acceptInvite(serviceId, networkId)"
    >
      <fieldset :disabled="!canWrite">
        <legend>{{ t('p2p.pairing.acceptTitle') }}</legend>
        <label>
          <span>{{ t('p2p.pairing.codeLabel') }}</span>
          <input
            v-model="state.codeDraft"
            autocomplete="off"
            spellcheck="false"
            data-testid="p2p-invite-input"
          />
        </label>
        <button class="prototype-button prototype-button--primary" type="submit">
          {{ t('p2p.pairing.accept') }}
        </button>
      </fieldset>
      <p class="remote-form-hint">{{ t('p2p.pairing.acceptHint') }}</p>
    </form>

    <p v-if="state.pairs === undefined">{{ t('p2p.pairing.unknown') }}</p>
    <p v-else-if="state.pairs.length === 0">{{ t('p2p.pairing.empty') }}</p>
    <ul v-else class="p2p-pairs">
      <li v-for="pair in state.pairs" :key="pair.pairId" :data-state="pair.state">
        <dl>
          <dt>{{ t('p2p.pairing.state') }}</dt>
          <!-- State is carried by text, never by colour alone. -->
          <dd data-testid="p2p-pair-state">{{ t(stateLabels[pair.state]) }}</dd>
        </dl>
        <!-- Live connection stage, kept visually distinct from pair state. -->
        <div v-if="pair.state === 'active'" class="p2p-pair-connection">
          <dl>
            <dt>{{ t('p2p.connection.title') }}</dt>
            <dd data-testid="p2p-connection-stage">
              {{
                connections.find(serviceId, pair.pairId)
                  ? t(stageLabels[connections.find(serviceId, pair.pairId)!.stage])
                  : t('p2p.connection.none')
              }}
            </dd>
            <template v-if="connections.isDirect(serviceId, pair.pairId)">
              <dt>{{ t('p2p.connection.direct') }}</dt>
              <dd>{{ t('p2p.connection.pathHint') }}</dd>
            </template>
          </dl>
          <p class="remote-form-hint">{{ t('p2p.connection.isolated') }}</p>
          <!-- Disconnect reconciliation: a lost link is not a stopped task. -->
          <div
            v-if="work.needsAttention(serviceId, pair.pairId)"
            class="p2p-pair-work"
            role="alert"
            data-testid="p2p-work-reconcile"
          >
            <h5>{{ t('p2p.work.title') }}</h5>
            <p v-if="work.verdict(serviceId, pair.pairId).kind === 'connection_lost'">
              {{ t('p2p.work.connectionLost') }}
            </p>
            <p v-else-if="work.verdict(serviceId, pair.pairId).kind === 'runtime_replaced'">
              {{ t('p2p.work.runtimeReplaced') }}
            </p>
            <p v-else>{{ t('p2p.work.unknown') }}</p>
            <p class="remote-form-hint">{{ t('p2p.work.noReplay') }}</p>
            <button
              type="button"
              class="prototype-button"
              data-testid="p2p-work-reconciled"
              @click="work.markReconciled(serviceId, pair.pairId)"
            >
              {{ t('p2p.work.markReconciled') }}
            </button>
          </div>
          <button
            v-if="connections.isReady(serviceId, pair.pairId)"
            type="button"
            class="prototype-button"
            data-testid="p2p-work-note-started"
            @click="work.noteWorkStarted(serviceId, pair.pairId)"
          >
            {{ t('p2p.work.noteStarted') }}
          </button>
          <P2PRemoteProjectsPanel
            v-if="connections.isReady(serviceId, pair.pairId)"
            :key="`remote-${pair.pairId}`"
            :service-id="serviceId"
            :pair-id="pair.pairId"
          />
          <div class="p2p-pair-actions">
            <button
              type="button"
              class="prototype-button prototype-button--primary"
              :disabled="
                pending ||
                live.resultUnconfirmed ||
                connections.isConnecting(serviceId, pair.pairId) ||
                connections.isReady(serviceId, pair.pairId)
              "
              data-testid="p2p-connection-connect"
              @click="connections.connect(serviceId, pair.pairId)"
            >
              {{ t('p2p.connection.connect') }}
            </button>
            <button
              type="button"
              class="prototype-button"
              :disabled="
                pending || live.resultUnconfirmed || !connections.find(serviceId, pair.pairId)
              "
              data-testid="p2p-connection-disconnect"
              @click="connections.disconnect(serviceId, pair.pairId)"
            >
              {{ t('p2p.connection.disconnect') }}
            </button>
          </div>
        </div>
        <div class="p2p-pair-actions">
          <button
            v-if="awaitingConfirmation(pair)"
            type="button"
            class="prototype-button"
            :disabled="pending"
            data-testid="p2p-pair-review"
            @click="review(pair, $event)"
          >
            {{ t('p2p.pairing.review') }}
          </button>
          <button
            v-if="awaitingConfirmation(pair)"
            type="button"
            class="prototype-button"
            :disabled="!canWrite"
            @click="pairing.reject(serviceId, pair.pairId)"
          >
            {{ t('p2p.pairing.reject') }}
          </button>
          <button
            v-if="pair.state === 'active'"
            type="button"
            class="prototype-button"
            :disabled="pending"
            data-testid="p2p-pair-revoke"
            @click="askRevoke(pair, $event)"
          >
            {{ t('p2p.pairing.revoke') }}
          </button>
        </div>
      </li>
    </ul>

    <!-- Fingerprint confirmation: the only path that can authorize a device. -->
    <div
      v-if="state.reviewing"
      class="p2p-pairing-review"
      role="group"
      :aria-label="t('p2p.pairing.reviewTitle')"
      data-testid="p2p-pair-review-pane"
    >
      <h4 ref="reviewHeading" tabindex="-1">{{ t('p2p.pairing.reviewTitle') }}</h4>
      <p>{{ t('p2p.pairing.reviewHint') }}</p>
      <dl>
        <dt>{{ t('p2p.pairing.remoteName') }}</dt>
        <dd>{{ pairing.remoteOf(state.reviewing).name }}</dd>
        <dt>{{ t('p2p.pairing.remoteFingerprint') }}</dt>
        <dd>
          <code data-testid="p2p-remote-fingerprint">{{
            pairing.remoteOf(state.reviewing).fingerprint
          }}</code>
        </dd>
        <dt>{{ t('p2p.pairing.presenceHint') }}</dt>
        <dd>
          {{
            pairing.remoteOf(state.reviewing).presence === 'online'
              ? t('p2p.pairing.presenceOnline')
              : t('p2p.pairing.presenceOffline')
          }}
        </dd>
      </dl>
      <label>
        <span>{{ t('p2p.pairing.confirmLabel') }}</span>
        <input
          v-model="state.confirmDraft"
          autocomplete="off"
          spellcheck="false"
          data-testid="p2p-confirm-input"
        />
      </label>
      <p class="remote-form-hint">{{ t('p2p.pairing.confirmHint') }}</p>
      <div class="p2p-pair-actions">
        <button
          type="button"
          class="prototype-button prototype-button--primary"
          :disabled="!canWrite || !state.confirmDraft"
          data-testid="p2p-pair-approve"
          @click="pairing.approve(serviceId)"
        >
          {{ t('p2p.pairing.approve') }}
        </button>
        <button type="button" class="prototype-button" @click="closeReview()">
          {{ t('p2p.pairing.closeReview') }}
        </button>
      </div>
    </div>

    <div
      v-if="revoking"
      class="p2p-pairing-revoke"
      role="group"
      :aria-label="t('p2p.pairing.revoke')"
      data-testid="p2p-pair-revoke-confirm"
    >
      <p role="alert">{{ t('p2p.pairing.revokeWarning') }}</p>
      <div class="p2p-pair-actions">
        <button
          ref="confirmButton"
          type="button"
          class="prototype-button prototype-button--primary"
          :disabled="!canWrite"
          @click="confirmRevoke()"
        >
          {{ t('p2p.pairing.revoke') }}
        </button>
        <button type="button" class="prototype-button" @click="closeRevoke()">
          {{ t('p2p.pairing.closeReview') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.p2p-pairing {
  display: grid;
  min-width: 0;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.p2p-pairing fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.p2p-pairing-code,
.p2p-pairing-review,
.p2p-pairing-revoke {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}
.p2p-pairs {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.p2p-pairs li {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.p2p-pairing dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: var(--space-2);
  margin: 0;
}
.p2p-pairing dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.p2p-pair-work {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface-muted);
}
.p2p-pair-work h5 {
  margin: 0;
}
.p2p-pair-connection {
  display: grid;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--color-border);
}
.p2p-pair-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.p2p-pairing label {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
</style>
