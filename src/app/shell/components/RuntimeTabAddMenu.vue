<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  p2pConnections,
  p2pManagement,
  remoteConnectionsState
} from '@/app/domains/remote-connections'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import type { MessageKey } from '@/app/shared/i18n/i18n'
import type { P2PComputerView, P2PConnectionView } from '@/shared/p2p-management'
import { runtimeBrowser, type RuntimeRemoteTabId } from '../runtimeBrowserState'

const t = useTranslator()
const browser = runtimeBrowser
const emit = defineEmits<{ navigate: [route: 'remote'] }>()
const open = ref(false)
const trigger = ref<HTMLButtonElement>()
const menu = ref<HTMLElement>()
const menuStyle = ref<Record<string, string>>()

type AddTabOptionState = 'ready' | 'connecting' | 'failed' | 'disconnected'
interface AddTabOption {
  readonly id: RuntimeRemoteTabId
  readonly title: string
  readonly detail: string
  readonly statusLabel: string
  readonly statusState: AddTabOptionState
  readonly available: boolean
}

const peerStageLabels: Record<P2PConnectionView['stage'], MessageKey> = {
  punching: 'p2p.connection.stagePunching',
  'starting-runtime': 'p2p.connection.stageStarting',
  ready: 'p2p.connection.stageReady',
  failed: 'p2p.connection.stageFailed',
  disconnected: 'p2p.connection.stageDisconnected'
}

function remoteStatusLabel(kind: 'disconnected' | 'connecting' | 'ready' | 'failed'): string {
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

function peerStatusLabel(computer: P2PComputerView): string {
  if (computer.pairState === 'revoked') return t('p2p.pairing.stateRevoked')
  const connection = p2pConnections.find(computer.serviceId, computer.pairId)
  return connection === undefined ? t('p2p.connection.none') : t(peerStageLabels[connection.stage])
}

function peerStatusState(computer: P2PComputerView): AddTabOptionState {
  if (computer.pairState === 'revoked') return 'disconnected'
  const connection = p2pConnections.find(computer.serviceId, computer.pairId)
  if (connection === undefined) return 'disconnected'
  switch (connection.stage) {
    case 'punching':
    case 'starting-runtime':
      return 'connecting'
    case 'ready':
      return 'ready'
    case 'failed':
      return 'failed'
    case 'disconnected':
      return 'disconnected'
  }
}

function sortAvailableFirst(left: AddTabOption, right: AddTabOption): number {
  return Number(right.available) - Number(left.available)
}

const peerOptions = computed<readonly AddTabOption[]>(() =>
  (p2pManagement.catalog.value?.computers ?? [])
    .filter(
      (computer) => !browser.tabs.value.some((tab) => tab.id === `peer:${computer.connectionId}`)
    )
    .map((computer) => ({
      id: `peer:${computer.connectionId}` as const,
      title: computer.displayName,
      detail: '',
      statusLabel: peerStatusLabel(computer),
      statusState: peerStatusState(computer),
      available:
        computer.pairState === 'active' &&
        p2pConnections.isReady(computer.serviceId, computer.pairId)
    }))
    .sort(sortAvailableFirst)
)

const remoteOptions = computed<readonly AddTabOption[]>(() =>
  remoteConnectionsState.value.connections
    .filter(
      (connection) =>
        !browser.tabs.value.some((tab) => tab.id === `remote:${connection.connectionId}`)
    )
    .map((connection) => ({
      id: `remote:${connection.connectionId}` as const,
      title: connection.displayName,
      detail: `${connection.user}@${connection.host}:${connection.port}`,
      statusLabel: remoteStatusLabel(connection.status.kind),
      statusState: connection.status.kind,
      available: connection.status.kind === 'ready'
    }))
    .sort(sortAvailableFirst)
)

const peerAvailableCount = computed(
  () => peerOptions.value.filter((option) => option.available).length
)
const remoteAvailableCount = computed(
  () => remoteOptions.value.filter((option) => option.available).length
)
const hasAddableWorkspaces = computed(
  () => peerOptions.value.length > 0 || remoteOptions.value.length > 0
)

function updateMenuPosition(): void {
  const element = trigger.value
  if (element === undefined) return
  const rect = element.getBoundingClientRect()
  const gutter = 12
  const gap = 8
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const width = Math.min(400, Math.max(0, viewportWidth - gutter * 2))
  const left = Math.min(
    Math.max(gutter, rect.right - width),
    Math.max(gutter, viewportWidth - width - gutter)
  )
  const below = Math.max(0, viewportHeight - rect.bottom - gap - gutter)
  const above = Math.max(0, rect.top - gap - gutter)
  const opensAbove = below < 320 && above > below
  menuStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${opensAbove ? above : below}px`,
    ...(opensAbove
      ? { top: 'auto', bottom: `${Math.max(0, viewportHeight - rect.top + gap)}px` }
      : { top: `${rect.bottom + gap}px`, bottom: 'auto' })
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (trigger.value?.contains(target) || menu.value?.contains(target)) return
  close()
}

function addGlobalListeners(): void {
  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('resize', updateMenuPosition)
  window.addEventListener('scroll', updateMenuPosition, true)
}

function removeGlobalListeners(): void {
  document.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('resize', updateMenuPosition)
  window.removeEventListener('scroll', updateMenuPosition, true)
}

function close(): void {
  open.value = false
  removeGlobalListeners()
  trigger.value?.focus()
}

function toggle(): void {
  if (open.value) close()
  else {
    updateMenuPosition()
    open.value = true
    addGlobalListeners()
  }
}

function select(id: RuntimeRemoteTabId): void {
  if (!browser.openRemoteTab(id)) return
  close()
}

function manage(): void {
  close()
  emit('navigate', 'remote')
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  event.preventDefault()
  close()
}

onUnmounted(removeGlobalListeners)
</script>

<template>
  <div class="browser-tab-add" @keydown="onEscape">
    <button
      ref="trigger"
      class="browser-tab-add-button"
      type="button"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-controls="runtime-add-tab-menu"
      :title="t('runtime.addTab.button')"
      :aria-label="t('runtime.addTab.button')"
      data-testid="runtime-add-tab"
      @click="toggle"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
    <Teleport to="body">
      <section
        v-if="open"
        ref="menu"
        id="runtime-add-tab-menu"
        class="runtime-add-tab-menu"
        role="dialog"
        aria-modal="false"
        aria-labelledby="runtime-add-tab-title"
        aria-describedby="runtime-add-tab-description"
        :style="menuStyle"
        :aria-label="t('runtime.addTab.title')"
        data-testid="runtime-add-tab-menu"
        @keydown="onEscape"
      >
        <header>
          <div>
            <h3 id="runtime-add-tab-title">{{ t('runtime.addTab.title') }}</h3>
            <p id="runtime-add-tab-description">{{ t('runtime.addTab.description') }}</p>
          </div>
          <button
            class="runtime-add-tab-close"
            type="button"
            :aria-label="t('runtime.addTab.close')"
            :title="t('runtime.addTab.close')"
            data-testid="runtime-add-tab-close"
            @click="close"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </header>
        <div v-if="peerOptions.length > 0" class="runtime-add-tab-group">
          <div class="runtime-add-tab-group-heading">
            <h4>{{ t('runtime.addTab.lan') }}</h4>
            <span class="runtime-add-tab-count" :aria-label="t('runtime.addTab.count')"
              >{{ peerAvailableCount }}/{{ peerOptions.length }}</span
            >
          </div>
          <template v-for="(option, index) in peerOptions" :key="option.id">
            <p
              v-if="index === peerAvailableCount && peerAvailableCount < peerOptions.length"
              class="runtime-add-tab-unavailable-label"
            >
              {{ t('runtime.addTab.unavailable') }}
            </p>
            <button
              class="runtime-add-tab-option"
              :class="{ 'runtime-add-tab-option--disabled': !option.available }"
              type="button"
              :disabled="!option.available"
              :aria-label="`${option.title} · ${option.statusLabel}`"
              :data-testid="`runtime-add-peer-${option.id.slice('peer:'.length)}`"
              :data-state="option.statusState"
              @click="select(option.id)"
            >
              <span
                class="browser-tab-status"
                :data-state="option.statusState"
                aria-hidden="true"
              />
              <span class="runtime-add-tab-option-copy">
                <strong>{{ option.title }}</strong>
                <small>{{ option.statusLabel }}</small>
              </span>
            </button>
          </template>
        </div>
        <div v-if="remoteOptions.length > 0" class="runtime-add-tab-group">
          <div class="runtime-add-tab-group-heading">
            <h4>{{ t('runtime.addTab.ssh') }}</h4>
            <span class="runtime-add-tab-count" :aria-label="t('runtime.addTab.count')"
              >{{ remoteAvailableCount }}/{{ remoteOptions.length }}</span
            >
          </div>
          <template v-for="(option, index) in remoteOptions" :key="option.id">
            <p
              v-if="index === remoteAvailableCount && remoteAvailableCount < remoteOptions.length"
              class="runtime-add-tab-unavailable-label"
            >
              {{ t('runtime.addTab.unavailable') }}
            </p>
            <button
              class="runtime-add-tab-option"
              :class="{ 'runtime-add-tab-option--disabled': !option.available }"
              type="button"
              :disabled="!option.available"
              :aria-label="`${option.title} · ${option.statusLabel}`"
              :data-testid="`runtime-add-ssh-${option.id.slice('remote:'.length)}`"
              :data-state="option.statusState"
              @click="select(option.id)"
            >
              <span
                class="browser-tab-status"
                :data-state="option.statusState"
                aria-hidden="true"
              />
              <span class="runtime-add-tab-option-copy">
                <strong>{{ option.title }}</strong>
                <small>{{ option.statusLabel }} · {{ option.detail }}</small>
              </span>
            </button>
          </template>
        </div>
        <div v-if="!hasAddableWorkspaces" class="runtime-add-tab-empty">
          <p>{{ t('runtime.addTab.empty') }}</p>
          <button
            class="prototype-button"
            type="button"
            data-testid="runtime-add-tab-manage"
            @click="manage"
          >
            {{ t('runtime.addTab.manage') }}
          </button>
        </div>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
.browser-tab-add {
  position: relative;
  flex: none;
  padding: var(--space-2) var(--space-3) 0 0;
}

.browser-tab-add-button {
  display: grid;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text-muted);
  cursor: pointer;
  place-items: center;
}

.browser-tab-add-button svg,
.runtime-add-tab-close svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.browser-tab-add-button:hover,
.browser-tab-add-button[aria-expanded='true'] {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent), transparent 88%);
  color: var(--color-text);
}

.browser-tab-add-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.runtime-add-tab-menu {
  position: fixed;
  z-index: 20;
  display: grid;
  box-sizing: border-box;
  min-width: 0;
  max-height: min(32rem, calc(100vh - 8rem));
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-float);
}

.runtime-add-tab-menu > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.runtime-add-tab-close {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  place-items: center;
}

.runtime-add-tab-close:hover,
.runtime-add-tab-close:focus-visible {
  background: color-mix(in srgb, var(--color-text), transparent 94%);
  color: var(--color-text);
  outline: none;
}

.runtime-add-tab-close:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.runtime-add-tab-menu h3,
.runtime-add-tab-menu h4,
.runtime-add-tab-menu p {
  margin: 0;
}

.runtime-add-tab-menu h3 {
  color: var(--color-text);
  font-size: var(--type-section);
}

.runtime-add-tab-menu h4 {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.runtime-add-tab-menu header p,
.runtime-add-tab-empty p {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.runtime-add-tab-group {
  display: grid;
  gap: var(--space-1);
}

.runtime-add-tab-group-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}

.runtime-add-tab-count {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--type-caption);
  font-variant-numeric: tabular-nums;
}

.runtime-add-tab-unavailable-label {
  margin-top: var(--space-2) !important;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.runtime-add-tab-option {
  display: flex;
  min-width: 0;
  min-height: 2.75rem;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.runtime-add-tab-option:hover,
.runtime-add-tab-option:focus-visible {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent), transparent 92%);
  outline: none;
}

.runtime-add-tab-option--disabled,
.runtime-add-tab-option:disabled {
  border-color: color-mix(in srgb, var(--color-border), transparent 24%);
  background: color-mix(in srgb, var(--color-bg), var(--color-surface) 42%);
  color: var(--color-text-muted);
  cursor: not-allowed;
}

.runtime-add-tab-option--disabled:hover,
.runtime-add-tab-option--disabled:focus-visible,
.runtime-add-tab-option:disabled:hover,
.runtime-add-tab-option:disabled:focus-visible {
  border-color: color-mix(in srgb, var(--color-border), transparent 24%);
  background: color-mix(in srgb, var(--color-bg), var(--color-surface) 42%);
  outline: none;
}

.runtime-add-tab-option--disabled .browser-tab-status,
.runtime-add-tab-option:disabled .browser-tab-status {
  background: var(--color-text-muted);
}

.runtime-add-tab-option .browser-tab-status {
  display: block;
  width: 0.55rem;
  height: 0.55rem;
  flex: none;
  border-radius: 999px;
  background: var(--color-text-muted);
}

.runtime-add-tab-option .browser-tab-status[data-state='ready'] {
  background: var(--color-success);
}

.runtime-add-tab-option .browser-tab-status[data-state='connecting'] {
  background: var(--color-accent);
}

.runtime-add-tab-option .browser-tab-status[data-state='failed'],
.runtime-add-tab-option .browser-tab-status[data-state='disconnected'] {
  background: var(--color-danger);
}

.runtime-add-tab-option-copy {
  display: grid;
  min-width: 0;
  gap: 0.125rem;
}

.runtime-add-tab-option-copy strong,
.runtime-add-tab-option-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runtime-add-tab-option-copy small {
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.runtime-add-tab-empty {
  display: grid;
  gap: var(--space-2);
}
</style>
