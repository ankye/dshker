<script setup lang="ts">
import { computed } from 'vue'
import {
  p2pConnections as connections,
  p2pManagement as management,
  p2pWorkReconciliation as work
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { refusalKeyForCode } from '@/app/shared/i18n/i18n.refusals'

/**
 * Disconnected-state actions for one paired computer on the Run page.
 *
 * Connecting is offered only for a currently active pair: a revoked computer
 * keeps its old entry visible but must not be reconnectable. Reconnecting never
 * clears an outstanding work warning, because the transport coming back is not
 * evidence about a task that was already in flight.
 */
const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ edit: [] }>()
const t = useTranslator()

const computer = computed(() =>
  management.catalog.value?.computers.find((entry) => entry.connectionId === props.connectionId)
)
const pending = computed(() => (computer.value ? management.busy(computer.value.serviceId) : false))
const revoked = computed(() => computer.value?.pairState === 'revoked')
const live = computed(() =>
  computer.value ? connections.find(computer.value.serviceId, computer.value.pairId) : undefined
)
/** A prior failure means retry rather than a first connect. */
const failed = computed(() => live.value?.stage === 'failed')
const needsReconcile = computed(() =>
  computer.value ? work.needsAttention(computer.value.serviceId, computer.value.pairId) : false
)
/**
 * Why the connect button would do nothing if it were pressed.
 *
 * Every reason `connect()` refuses for is invisible from the outside: a service
 * with an operation in flight, an attempt this window already believes is running,
 * and an earlier attempt whose outcome is unknown. Pressing a button that answers
 * with silence is indistinguishable from a button that is broken, so the reason is
 * written beside it, and the unknown-outcome case names the page that clears it.
 */
const inertReason = computed(() => {
  const target = computer.value
  if (!target) return undefined
  if (management.busy(target.serviceId)) return t('p2p.connect.busyHint')
  if (connections.isConnecting(target.serviceId, target.pairId)) return t('p2p.refusal.connecting')
  if (connections.state.resultUnconfirmed) return t('p2p.run.unknownOutcome')
  return undefined
})

async function connect(): Promise<void> {
  const target = computer.value
  if (!target || revoked.value) return
  await connections.connect(target.serviceId, target.pairId)
}
</script>

<template>
  <div v-if="computer" class="remote-row-actions">
    <!-- A revoked pair keeps its record but must never reconnect. -->
    <p v-if="revoked" class="remote-form-hint" data-testid="p2p-run-revoked">
      {{ t('p2p.run.revoked') }}
    </p>
    <button
      v-else
      class="prototype-button prototype-button--primary"
      type="button"
      :disabled="
        pending ||
        connections.isConnecting(computer.serviceId, computer.pairId) ||
        connections.state.resultUnconfirmed
      "
      data-testid="p2p-run-connect"
      @click="connect()"
    >
      {{ failed ? t('p2p.run.retry') : t('p2p.run.connect') }}
    </button>
    <button
      class="prototype-button"
      type="button"
      :disabled="pending"
      data-testid="p2p-run-edit"
      @click="emit('edit')"
    >
      {{ t('p2p.run.edit') }}
    </button>
    <p v-if="inertReason" class="remote-form-hint" data-testid="p2p-run-inert">
      {{ inertReason }}
    </p>
    <!-- Carried over from the pairing view so the warning cannot be lost here. -->
    <p v-if="needsReconcile" role="alert" data-testid="p2p-run-reconcile">
      {{ t('p2p.work.unknown') }}
    </p>
    <!-- A refusal that proved nothing happened keeps the stage clean, so without
         this line the press would leave no trace at all on this page. -->
    <p v-if="connections.state.lastRefusal" role="status" data-testid="p2p-run-refusal">
      {{ t(refusalKeyForCode(connections.state.lastRefusal)) }}
      <code>{{ connections.state.lastRefusal }}</code>
    </p>
  </div>
</template>
