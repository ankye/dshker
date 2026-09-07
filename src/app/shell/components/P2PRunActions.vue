<script setup lang="ts">
import { computed } from 'vue'
import {
  p2pConnections as connections,
  p2pManagement as management,
  p2pWorkReconciliation as work
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'

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
      :disabled="pending || connections.isConnecting(computer.serviceId, computer.pairId)"
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
    <!-- Carried over from the pairing view so the warning cannot be lost here. -->
    <p v-if="needsReconcile" role="alert" data-testid="p2p-run-reconcile">
      {{ t('p2p.work.unknown') }}
    </p>
  </div>
</template>
