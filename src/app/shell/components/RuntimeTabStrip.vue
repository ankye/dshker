<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { runtimeBrowser, type RuntimeTab, type RuntimeTabId } from '../runtimeBrowserState'
import RuntimeTabAddMenu from './RuntimeTabAddMenu.vue'

const emit = defineEmits<{ navigate: [route: 'remote'] }>()
const t = useTranslator()
const browser = runtimeBrowser
const strip = ref<HTMLElement>()

function tabLabel(tab: RuntimeTab): string {
  return tab.source === 'local' ? t('runtime.localTab') : tab.label
}

function tabTooltip(tab: RuntimeTab): string {
  const label = tabLabel(tab)
  const detail = tab.title || tab.url
  return detail ? `${label} — ${detail}` : label
}

async function closeTab(id: RuntimeTabId): Promise<void> {
  if (!browser.closeRemoteTab(id)) return
  await nextTick()
  const selected = Array.from(
    strip.value?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []
  ).find((element) => element.dataset.testid === `runtime-tab-${browser.activeTabId.value}`)
  selected?.focus()
}
</script>

<template>
  <div class="browser-tabbar">
    <div ref="strip" class="browser-tab-strip" role="tablist" :aria-label="t('runtime.title')">
      <div
        v-for="tab in browser.tabs.value"
        :key="tab.id"
        class="browser-tab"
        role="presentation"
        :data-active="browser.activeTabId.value === tab.id"
        :data-state="
          tab.source === 'local' ? (tab.url ? 'ready' : 'disconnected') : tab.status?.kind
        "
      >
        <button
          class="browser-tab-select"
          type="button"
          role="tab"
          :aria-selected="browser.activeTabId.value === tab.id"
          :title="tabTooltip(tab)"
          :data-testid="`runtime-tab-${tab.id}`"
          @click="browser.activeTabId.value = tab.id"
          @keydown.delete.prevent="closeTab(tab.id)"
        >
          <span class="browser-tab-status" aria-hidden="true" />
          <span class="browser-tab-title">{{ tabLabel(tab) }}</span>
        </button>
        <button
          v-if="tab.source !== 'local'"
          class="browser-tab-close"
          type="button"
          :aria-label="`${t('runtime.closeTab')} — ${tabLabel(tab)}`"
          :title="t('runtime.closeTab')"
          :data-testid="`runtime-tab-close-${tab.id}`"
          @click="closeTab(tab.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
        </button>
      </div>
    </div>
    <RuntimeTabAddMenu @navigate="emit('navigate', $event)" />
  </div>
</template>

<style scoped>
.browser-tabbar {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  border-bottom: 1px solid var(--color-border);
}

.browser-tab-strip {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: flex-end;
  gap: 0.125rem;
  padding: var(--space-2) var(--space-3) 0;
  overflow-x: auto;
}

.browser-tab {
  position: relative;
  display: flex;
  max-width: 13rem;
  min-width: 0;
  flex-shrink: 0;
  align-items: center;
  border-radius: var(--radius) var(--radius) 0 0;
  color: var(--color-text-muted);
}

.browser-tab:hover {
  background: color-mix(in srgb, var(--color-text), transparent 94%);
  color: var(--color-text);
}

.browser-tab[data-active='true'] {
  background: var(--color-bg);
  color: var(--color-text);
}

.browser-tab[data-active='true']::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 2px;
  background: var(--color-accent);
  pointer-events: none;
}

.browser-tab-select {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  padding: 0.5rem 0.75rem;
  border: none;
  background: transparent;
  color: inherit;
  font-size: var(--type-caption);
  cursor: pointer;
}

.browser-tab-close {
  display: grid;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  margin-right: var(--space-2);
  padding: 0;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: inherit;
  cursor: pointer;
  place-items: center;
}

.browser-tab-close:hover {
  background: color-mix(in srgb, var(--color-text), transparent 88%);
}

.browser-tab-close svg {
  width: 0.875rem;
  height: 0.875rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.75;
}

.browser-tab-select:focus-visible,
.browser-tab-close:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.browser-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-tab-status {
  width: 0.45rem;
  height: 0.45rem;
  flex: none;
  border-radius: 999px;
  background: var(--color-text-muted);
}

.browser-tab[data-state='ready'] .browser-tab-status {
  background: var(--color-success);
}

.browser-tab[data-state='connecting'] .browser-tab-status,
.browser-tab[data-state='suspended'] .browser-tab-status {
  background: var(--color-accent);
}

.browser-tab[data-state='failed'] .browser-tab-status,
.browser-tab[data-state='disconnected'] .browser-tab-status {
  background: var(--color-danger);
}
</style>
