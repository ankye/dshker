<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
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
const form = reactive({ displayName: '', host: '', port: '', user: '', sshKeyPath: '' })
const addOpen = ref(false)
const addTrigger = ref<HTMLButtonElement>()
const addFirstInput = ref<HTMLInputElement>()

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

function resetForm(): void {
  form.displayName = ''
  form.host = ''
  form.port = ''
  form.user = ''
  form.sshKeyPath = ''
}

async function openAdd(): Promise<void> {
  addOpen.value = true
  await nextTick()
  addFirstInput.value?.focus()
}

async function closeAdd(): Promise<void> {
  if (remote.loading.value) return
  addOpen.value = false
  await nextTick()
  addTrigger.value?.focus()
}

async function submit(): Promise<void> {
  const created = await remote.create({
    displayName: form.displayName,
    host: form.host,
    port: Number(form.port),
    user: form.user,
    sshKeyPath: form.sshKeyPath
  })
  if (!created) return
  resetForm()
  await closeAdd()
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
        <div class="remote-list-heading-actions">
          <span class="remote-count">{{ remote.state.value.connections.length }}</span>
          <button
            ref="addTrigger"
            class="prototype-button prototype-button--primary"
            type="button"
            data-testid="remote-add-open"
            @click="openAdd"
          >
            {{ t('remote.add.open') }}
          </button>
        </div>
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
    </section>
    <RemoteConnectionEditor />
    <div v-if="addOpen" class="remote-dialog-layer" @click.self="closeAdd">
      <section
        class="remote-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-add-title"
        data-testid="remote-add-dialog"
        @keydown.esc.prevent="closeAdd"
      >
        <div class="remote-dialog-header">
          <div>
            <h2 id="remote-add-title">{{ t('remote.add.title') }}</h2>
            <p>{{ t('remote.add.description') }}</p>
          </div>
          <div class="remote-dialog-header-actions">
            <span class="remote-security-badge">{{ t('remote.security.badge') }}</span>
            <button
              class="remote-dialog-close prototype-button"
              type="button"
              :aria-label="t('remote.add.close')"
              :disabled="remote.loading.value"
              data-testid="remote-add-close"
              @click="closeAdd"
            >
              {{ t('remote.edit.cancel') }}
            </button>
          </div>
        </div>
        <form class="remote-add-form" data-testid="remote-add-form" @submit.prevent="submit">
          <label
            ><span>{{ t('remote.field.name') }}</span
            ><input
              ref="addFirstInput"
              v-model="form.displayName"
              type="text"
              required
              autocomplete="off"
          /></label>
          <label
            ><span>{{ t('remote.field.host') }}</span
            ><input v-model="form.host" type="text" required spellcheck="false" autocomplete="off"
          /></label>
          <label
            ><span>{{ t('remote.field.port') }}</span
            ><input
              v-model="form.port"
              type="number"
              required
              min="1"
              max="65535"
              inputmode="numeric"
          /></label>
          <label
            ><span>{{ t('remote.field.user') }}</span
            ><input
              v-model="form.user"
              type="text"
              required
              spellcheck="false"
              autocomplete="username"
          /></label>
          <label class="remote-add-form-wide"
            ><span>{{ t('remote.field.sshKeyPath') }}</span
            ><input
              v-model="form.sshKeyPath"
              type="text"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('remote.field.sshKeyPathPlaceholder')"
            />
          </label>
          <div class="remote-dialog-actions">
            <button
              class="prototype-button prototype-button--primary"
              type="submit"
              :disabled="remote.loading.value"
            >
              {{ remote.loading.value ? t('remote.add.saving') : t('remote.add.action') }}
            </button>
            <button
              class="prototype-button"
              type="button"
              :disabled="remote.loading.value"
              @click="closeAdd"
            >
              {{ t('remote.edit.cancel') }}
            </button>
          </div>
        </form>
        <p class="remote-form-hint">{{ t('remote.add.hint') }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.remote-computer-list {
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
}
.remote-list-heading-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
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
.remote-add-form-wide {
  grid-column: 1 / -1;
}
.remote-dialog-layer {
  position: fixed;
  z-index: 30;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-6);
  overflow: auto;
  background: rgb(4 9 16 / 68%);
}
.remote-add-dialog {
  display: grid;
  width: min(42rem, 100%);
  min-width: 0;
  max-height: calc(100vh - 2 * var(--space-6));
  gap: var(--space-3);
  overflow: auto;
  box-sizing: border-box;
  padding: var(--space-5);
  border: 1px solid var(--color-border-strong, var(--color-border));
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg, 0 1rem 3rem rgb(0 0 0 / 35%));
}
.remote-add-dialog .remote-add-form {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  min-width: 0;
}
.remote-add-dialog .remote-add-form label,
.remote-add-dialog .remote-add-form input {
  min-width: 0;
}
.remote-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
.remote-dialog-header p {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}
.remote-dialog-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.remote-dialog-close {
  flex: 0 0 auto;
}
.remote-add-dialog .remote-section-heading {
  margin: 0;
}
.remote-add-dialog h2 {
  margin: 0;
  font-size: var(--type-section);
}
.remote-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  grid-column: 1 / -1;
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
@media (max-width: 560px) {
  .remote-dialog-layer {
    padding: var(--space-3);
  }
  .remote-dialog-header {
    flex-direction: column;
  }
  .remote-dialog-header-actions {
    justify-content: flex-start;
  }
  .remote-add-dialog .remote-add-form {
    grid-template-columns: minmax(0, 1fr);
  }
  .remote-add-dialog .remote-add-form-wide,
  .remote-dialog-actions {
    grid-column: 1;
  }
}
</style>
