<script setup lang="ts">
import type { P2PComputerNetworkChoices } from '@/shared/p2p-management'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { refusalKeyForCode } from '@/app/shared/i18n/i18n.refusals'

defineProps<{
  device: P2PComputerNetworkChoices
  pending: boolean
  loading: boolean
  readFailed: boolean
  unconfirmed: boolean
  error: string
}>()
const emit = defineEmits<{ choose: [networkId: string]; back: []; refresh: [] }>()
const t = useTranslator()
</script>

<template>
  <section
    class="network-choice"
    :aria-busy="pending || loading"
    data-testid="runtime-network-choice"
  >
    <button
      type="button"
      class="prototype-button"
      data-testid="runtime-network-back"
      @click="emit('back')"
    >
      {{ t('p2p.networkChoice.back') }}
    </button>
    <div>
      <h4>{{ device.name }}</h4>
      <p>
        {{ t(device.state === 'stale' ? 'p2p.networkChoice.stale' : 'p2p.networkChoice.hint') }}
      </p>
    </div>
    <p v-if="pending || loading" role="status">
      {{ t(pending ? 'p2p.networkChoice.pending' : 'p2p.networkChoice.loading') }}
    </p>
    <p v-if="unconfirmed" role="status">{{ t('p2p.networkChoice.unconfirmed') }}</p>
    <p v-if="readFailed" role="alert">{{ t('p2p.networkChoice.readFailed') }}</p>
    <p v-else-if="error" role="alert">{{ t(refusalKeyForCode(error)) }}</p>
    <button
      v-if="error || unconfirmed || readFailed || device.choices.length === 0"
      type="button"
      class="prototype-button"
      :disabled="pending || loading"
      data-testid="runtime-network-refresh"
      @click="emit('refresh')"
    >
      {{ t('p2p.networkChoice.refresh') }}
    </button>
    <ul>
      <li v-for="choice in device.choices" :key="choice.networkId">
        <button
          type="button"
          :disabled="pending || loading || readFailed || unconfirmed"
          :data-testid="`runtime-network-select-${choice.networkId}`"
          @click="emit('choose', choice.networkId)"
        >
          <strong>{{ choice.name }}</strong>
          <code>{{ choice.networkId }}</code>
        </button>
      </li>
    </ul>
    <p v-if="device.choices.length === 0">{{ t('p2p.networkChoice.empty') }}</p>
  </section>
</template>

<style scoped>
.network-choice {
  display: grid;
  min-width: 0;
  gap: var(--space-3);
}
.network-choice h4,
.network-choice p {
  margin: 0;
  overflow-wrap: anywhere;
}
.network-choice p,
.network-choice code {
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.network-choice ul {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.network-choice li {
  min-width: 0;
}
.network-choice li button {
  display: grid;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}
.network-choice strong,
.network-choice code {
  overflow-wrap: anywhere;
}
.network-choice li button:hover:not(:disabled),
.network-choice li button:focus-visible {
  border-color: var(--color-accent);
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.network-choice li button:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
}
</style>
