<script setup lang="ts">
import { reactive } from 'vue'
import { remoteConnectionEditor, useRemoteConnections } from '@/app/domains/remote-connections'
import RemoteConnectionEditor from './RemoteConnectionEditor.vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/messages.zh-CN'
import type { RemoteConnectionErrorCode } from '@/shared/contracts'
import { runtimeBrowser } from '../runtimeBrowserState'
import type { AppRouteId } from '@/app/shared/navigation/routes'

const t = useTranslator()
const remote = useRemoteConnections()
const emit = defineEmits<{ navigate: [route: AppRouteId] }>()
const form = reactive({ displayName: '', host: '', port: '', user: '' })

const REMOTE_ERROR_KEYS: Readonly<Record<RemoteConnectionErrorCode, MessageKey>> = {
  'remote.invalid_request': 'remote.error.invalidRequest',
  'remote.invalid_record': 'remote.error.invalidRecord',
  'remote.unsupported_version': 'remote.error.unsupportedVersion',
  'remote.persistence_failed': 'remote.error.persistence',
  'remote.connection_not_found': 'remote.error.notFound',
  'remote.connection_exists': 'remote.error.exists',
  'remote.connection_busy': 'remote.error.busy',
  'remote.config_conflict': 'remote.edit.conflict',
  'remote.connection_not_disconnected': 'remote.error.notDisconnected',
  'remote.ssh_unavailable': 'remote.error.sshUnavailable',
  'remote.ssh_authentication_failed': 'remote.error.sshAuthentication',
  'remote.peer_unavailable': 'remote.error.peerUnavailable',
  'remote.peer_authentication_failed': 'remote.error.peerAuthentication',
  'remote.peer_protocol_invalid': 'remote.error.peerProtocol',
  'remote.tunnel_failed': 'remote.error.tunnel'
}

async function submit(): Promise<void> {
  const created = await remote.create({
    displayName: form.displayName,
    host: form.host,
    port: Number(form.port),
    user: form.user
  })
  if (!created) return
  form.displayName = ''
  form.host = ''
  form.port = ''
  form.user = ''
}

function statusLabel(kind: 'disconnected' | 'connecting' | 'ready' | 'failed'): string {
  switch (kind) {
    case 'disconnected':
      return t('remote.status.disconnected')
    case 'connecting':
      return t('remote.status.connecting')
    case 'ready':
      return t('remote.status.ready')
    case 'failed':
      return t('remote.status.failed')
  }
}

function testStatusLabel(kind: 'untested' | 'testing' | 'passed' | 'failed'): string {
  switch (kind) {
    case 'untested':
      return t('remote.testStatus.untested')
    case 'testing':
      return t('remote.testStatus.testing')
    case 'passed':
      return t('remote.testStatus.passed')
    case 'failed':
      return t('remote.testStatus.failed')
  }
}

function errorLabel(code: RemoteConnectionErrorCode | 'bridge' | 'unconfirmed'): string {
  if (code === 'unconfirmed') return t('remote.edit.unconfirmed')
  return code === 'bridge' ? t('remote.error.bridge') : t(REMOTE_ERROR_KEYS[code])
}

function openWorkbench(connectionId: string): void {
  if (runtimeBrowser.openRemoteTab(`remote:${connectionId}`)) emit('navigate', 'runtime')
}
</script>

<template>
  <div class="remote-connections-layout">
    <section class="remote-list-card" aria-labelledby="remote-list-title">
      <div class="remote-section-heading">
        <div>
          <h2 id="remote-list-title">{{ t('remote.list.title') }}</h2>
          <p>{{ t('remote.list.description') }}</p>
        </div>
        <span class="remote-count">{{ remote.state.value.connections.length }}</span>
      </div>
      <div v-if="remote.state.value.connections.length === 0" class="remote-empty">
        <strong>{{ t('remote.empty') }}</strong>
        <p>{{ t('remote.empty.description') }}</p>
      </div>
      <ul v-else class="remote-computer-list">
        <li
          v-for="connection in remote.state.value.connections"
          :key="connection.connectionId"
          class="remote-computer-row"
        >
          <span class="remote-computer-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <div class="remote-computer-copy">
            <div class="remote-computer-title">
              <strong>{{ connection.displayName }}</strong>
              <span class="remote-status" :data-state="connection.status.kind">
                <span class="remote-status-dot" aria-hidden="true"></span>
                {{ statusLabel(connection.status.kind) }}
              </span>
              <span class="remote-test-status" :data-state="connection.testStatus.kind">
                <span class="remote-status-dot" aria-hidden="true"></span>
                {{ testStatusLabel(connection.testStatus.kind) }}
              </span>
            </div>
            <code>{{ connection.user }}@{{ connection.host }}:{{ connection.port }}</code>
            <p v-if="connection.status.kind === 'failed'" class="remote-row-error">
              {{ errorLabel(connection.status.code) }} · {{ connection.status.code }}
            </p>
            <p
              v-if="connection.testStatus.kind === 'failed' && connection.status.kind !== 'failed'"
              class="remote-row-error"
            >
              {{ t('remote.test.failurePrefix') }}：{{ errorLabel(connection.testStatus.code) }} ·
              {{ connection.testStatus.code }}
            </p>
          </div>
          <div class="remote-row-actions">
            <button
              v-if="
                connection.status.kind === 'disconnected' || connection.status.kind === 'failed'
              "
              class="prototype-button"
              type="button"
              :disabled="remote.pendingActions.value[connection.connectionId] !== undefined"
              @click="remote.test(connection.connectionId)"
              data-testid="remote-test-connection"
            >
              {{
                remote.pendingActions.value[connection.connectionId] === 'test'
                  ? t('remote.test.testing')
                  : t('remote.test.action')
              }}
            </button>
            <button
              v-if="
                connection.status.kind === 'disconnected' || connection.status.kind === 'failed'
              "
              class="prototype-button prototype-button--primary"
              type="button"
              :disabled="remote.pendingActions.value[connection.connectionId] !== undefined"
              @click="remote.connect(connection.connectionId)"
            >
              {{ connection.status.kind === 'failed' ? t('remote.retry') : t('remote.connect') }}
            </button>
            <button
              v-else
              class="prototype-button"
              type="button"
              @click="remote.disconnect(connection.connectionId)"
            >
              {{ t('remote.disconnect') }}
            </button>
            <button
              class="prototype-button prototype-button--primary"
              type="button"
              :data-testid="`remote-open-workbench-${connection.connectionId}`"
              @click="openWorkbench(connection.connectionId)"
            >
              {{ t('remote.openWorkbench') }}
            </button>
            <details class="connect-row-management">
              <summary>{{ t('remote.connectLayout.manage') }}</summary>
              <div class="connect-management-actions">
                <button
                  :id="`remote-edit-${connection.connectionId}`"
                  class="prototype-button"
                  type="button"
                  :disabled="remote.pendingActions.value[connection.connectionId] !== undefined"
                  @click="remoteConnectionEditor.open(connection.connectionId)"
                >
                  {{ t('remote.edit.action') }}
                </button>
                <button
                  class="prototype-button prototype-button--danger"
                  type="button"
                  :disabled="
                    connection.status.kind !== 'disconnected' ||
                    remote.pendingActions.value[connection.connectionId] !== undefined
                  "
                  @click="remote.remove(connection.connectionId)"
                >
                  {{ t('remote.remove') }}
                </button>
              </div>
            </details>
          </div>
        </li>
      </ul>
      <p v-if="remote.error.value" class="remote-error" role="alert">
        {{ errorLabel(remote.error.value) }} · {{ remote.error.value }}
      </p>
      <details class="connect-add-disclosure" :open="remote.state.value.connections.length === 0">
        <summary>{{ t('remote.add.title') }}</summary>
        <div class="remote-section-heading">
          <p>{{ t('remote.add.description') }}</p>
          <span class="remote-security-badge">{{ t('remote.security.badge') }}</span>
        </div>
        <form class="remote-add-form" data-testid="remote-add-form" @submit.prevent="submit">
          <label
            ><span>{{ t('remote.field.name') }}</span
            ><input v-model="form.displayName" type="text" autocomplete="off"
          /></label>
          <label
            ><span>{{ t('remote.field.host') }}</span
            ><input v-model="form.host" type="text" spellcheck="false" autocomplete="off"
          /></label>
          <label
            ><span>{{ t('remote.field.port') }}</span
            ><input v-model="form.port" type="number" min="1" max="65535" inputmode="numeric"
          /></label>
          <label
            ><span>{{ t('remote.field.user') }}</span
            ><input v-model="form.user" type="text" spellcheck="false" autocomplete="username"
          /></label>
          <button
            class="prototype-button prototype-button--primary"
            type="submit"
            :disabled="remote.loading.value"
          >
            {{ remote.loading.value ? t('remote.add.saving') : t('remote.add.action') }}
          </button>
        </form>
        <p class="remote-form-hint">{{ t('remote.add.hint') }}</p>
      </details>
    </section>
    <RemoteConnectionEditor />
  </div>
</template>

<style scoped>
.remote-computer-list {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
}
.remote-computer-row {
  padding: var(--space-3) var(--space-4);
}
.remote-computer-copy {
  min-width: 0;
}
.remote-computer-copy strong,
.remote-computer-copy code {
  overflow-wrap: anywhere;
}
.connect-row-management {
  min-width: 5rem;
}
.connect-row-management summary {
  color: var(--color-accent);
}
.connect-management-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-2);
}
summary {
  cursor: pointer;
  min-height: var(--size-control-md);
  align-content: center;
}
summary:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
.connect-add-disclosure > summary {
  font-size: var(--type-section);
  font-weight: var(--font-weight-semibold);
}
.connect-add-disclosure {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}
.connect-add-disclosure > .remote-section-heading {
  margin-block: var(--space-3);
}
@media (max-width: 880px) {
  .remote-computer-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .remote-row-actions {
    grid-column: 2;
    flex-wrap: wrap;
    justify-content: flex-start;
  }
}
</style>
