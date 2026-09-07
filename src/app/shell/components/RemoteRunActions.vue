<script setup lang="ts">
import { computed } from 'vue'
import { remoteConnectionEditor, useRemoteConnections } from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ edit: [] }>()
const t = useTranslator()
const remote = useRemoteConnections()
const current = computed(() =>
  remote.state.value.connections.find((entry) => entry.connectionId === props.connectionId)
)

function edit(): void {
  remoteConnectionEditor.open(props.connectionId)
  emit('edit')
}
</script>

<template>
  <div v-if="current" class="remote-row-actions">
    <button
      class="prototype-button prototype-button--primary"
      type="button"
      :disabled="remote.pendingActions.value[connectionId] !== undefined"
      @click="remote.connect(connectionId)"
    >
      {{ current.status.kind === 'failed' ? t('remote.retry') : t('remote.connect') }}
    </button>
    <button
      class="prototype-button"
      type="button"
      :disabled="remote.pendingActions.value[connectionId] !== undefined"
      @click="edit"
    >
      {{ t('remote.edit.action') }}
    </button>
  </div>
</template>
