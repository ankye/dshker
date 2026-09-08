<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  p2pConnections as connections,
  p2pManagement as management,
  p2pPairing as pairing,
  p2pWorkReconciliation as work
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { useLauncherShell } from '../useLauncherShell'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import type { P2PConnectionView, P2PPairView } from '@/shared/p2p-management'
import P2PRemoteProjectsPanel from './P2PRemoteProjectsPanel.vue'

const props = defineProps<{ serviceId: string; networkId: string | undefined }>()
const t = useTranslator()
const shell = useLauncherShell()
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
const title = ref<HTMLHeadingElement>()

const live = computed(() => connections.state)
/**
 * Friendly diagnosis for the failures a user can actually fix. Anything else
 * keeps the raw code, which the troubleshooting docs explain.
 */
const connectHints: Readonly<Record<string, MessageKey>> = {
  'p2p.peer_offline': 'p2p.connect.offlineHint',
  'p2p.direct_unavailable': 'p2p.connect.directHint',
  'p2p.connection_busy': 'p2p.connect.busyHint'
}
const connectHint = computed(() => {
  const error = management.operations[`connect:${props.serviceId}`]?.error
  return error && typeof error === 'string' && connectHints[error]
    ? t(connectHints[error])
    : undefined
})

onMounted(() => {
  // Reads are safe and cheap: load automatically instead of demanding a click.
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
  invited: 'p2p.pairing.statePendingTarget',
  approved: 'p2p.pairing.statePendingInitiator',
  active: 'p2p.pairing.stateActive',
  revoked: 'p2p.pairing.stateRevoked',
  rejected: 'p2p.pairing.stateRevoked'
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

    <form
      v-if="false"
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
        <!-- Identity first: which computer this row is. -->
        <h4 class="p2p-member-name" data-testid="p2p-member-name">
          {{ pairing.remoteOf(pair).name || pairing.remoteOf(pair).deviceId }}
        </h4>
        <p class="p2p-member-id">
          <code>{{ pairing.remoteOf(pair).deviceId }}</code>
        </p>
        <dl>
          <dt>{{ t('p2p.member.state') }}</dt>
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
          <p v-if="connectHint" role="alert" class="remote-error" data-testid="p2p-connect-hint">
            {{ connectHint }}
          </p>
          <div class="p2p-pair-actions">
            <button
              v-if="connections.isReady(serviceId, pair.pairId)"
              type="button"
              class="prototype-button prototype-button--primary"
              data-testid="p2p-open-workbench"
              @click="shell.selectRoute('runtime')"
            >
              {{ t('p2p.connect.openWorkbench') }}
            </button>
            <button
              v-if="!connections.isReady(serviceId, pair.pairId)"
              type="button"
              class="prototype-button prototype-button--primary"
              :disabled="
                pending ||
                live.resultUnconfirmed ||
                connections.isConnecting(serviceId, pair.pairId)
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
      </li>
    </ul>
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
.p2p-member-name {
  margin: 0;
  font-size: var(--type-ui);
  font-weight: var(--font-weight-semibold);
}
.p2p-member-id {
  margin: 0;
}
.p2p-member-id code {
  font-size: var(--type-caption);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
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
