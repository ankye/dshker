<script setup lang="ts">
import { ref } from 'vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import P2PJoinPanel from './P2PJoinPanel.vue'
import P2PNetworkAccountPanel from './P2PNetworkAccountPanel.vue'
import RemoteSSHManagementPanel from './RemoteSSHManagementPanel.vue'

type RemoteTab = 'connect' | 'account'

/**
 * Two operational sub-tabs of the remote route.
 *
 * Tab 1 「连接」 is login-free (SSH hosts, plus the「我的网络」card that joins
 * a P2P network through the built-in official server). Tab 2 「网络与账户」
 * is login-gated and carries account, network, enrollment and pairing
 * management. Tabs never switch by themselves; cross-tab guidance asks the
 * user to switch explicitly.
 */
const t = useTranslator()
const activeTab = ref<RemoteTab>('connect')
</script>

<template>
  <div class="remote-connections-layout" data-testid="remote-connections-panel">
    <div class="remote-tabbar" role="tablist" :aria-label="t('p2p.tabs.remoteLabel')">
      <button
        id="remote-tab-connect"
        class="remote-tab"
        role="tab"
        type="button"
        :aria-selected="activeTab === 'connect'"
        :data-active="activeTab === 'connect'"
        data-testid="remote-tab-connect"
        @click="activeTab = 'connect'"
      >
        {{ t('p2p.tabs.connect') }}
      </button>
      <button
        id="remote-tab-account"
        class="remote-tab"
        role="tab"
        type="button"
        :aria-selected="activeTab === 'account'"
        :data-active="activeTab === 'account'"
        data-testid="remote-tab-account"
        @click="activeTab = 'account'"
      >
        {{ t('p2p.tabs.account') }}
      </button>
    </div>

    <section
      v-if="activeTab === 'connect'"
      class="remote-tab-pane"
      role="tabpanel"
      aria-labelledby="remote-tab-connect"
      data-testid="remote-pane-connect"
    >
      <p class="remote-tab-description">{{ t('p2p.tabs.connectDescription') }}</p>
      <RemoteSSHManagementPanel />
      <P2PJoinPanel />
    </section>

    <section
      v-if="activeTab === 'account'"
      class="remote-tab-pane"
      role="tabpanel"
      aria-labelledby="remote-tab-account"
      data-testid="remote-pane-account"
    >
      <P2PNetworkAccountPanel />
    </section>
  </div>
</template>

<style scoped>
.remote-tabbar {
  display: flex;
  align-self: stretch;
  gap: var(--space-1);
  border-bottom: 1px solid var(--color-border);
}
.remote-tab {
  position: relative;
  min-height: var(--size-control-md);
  padding: 0 var(--space-4);
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--type-ui);
  font-weight: var(--font-weight-medium);
}
.remote-tab[data-active='true'] {
  color: var(--color-text);
}
.remote-tab[data-active='true']::after {
  position: absolute;
  right: var(--space-4);
  bottom: -1px;
  left: var(--space-4);
  height: 2px;
  border-radius: 999px;
  background: var(--color-accent);
  content: '';
}
.remote-tab:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.remote-tab-pane {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.remote-tab-description {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
</style>
