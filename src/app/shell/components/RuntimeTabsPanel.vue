<script setup lang="ts">
import { ref, watch } from 'vue'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { isLoopbackAddress, runtimeBrowser } from '../runtimeBrowserState'
import EmptyState from './EmptyState.vue'

/** The Electron <webview> members this panel drives. */
interface RuntimeWebview extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getURL(): string
}

const t = useTranslator()
const browser = runtimeBrowser

/** Routing belongs to the shell, so a stopped runtime asks it to move. */
const emit = defineEmits<{ navigate: ['launch'] }>()
const frames = ref<Record<number, RuntimeWebview | undefined>>({})
const addressDraft = ref('')
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)

/** The guest element of the focused tab, when it is mounted. */
function activeFrame(): RuntimeWebview | undefined {
  const id = browser.activeTabId.value
  return id === undefined ? undefined : frames.value[id]
}

// A stopped runtime leaves nothing to show, so its tabs close with it.
watch(browser.runtimeUrl, (url) => {
  if (url === undefined) browser.resetTabs()
})

// The address bar follows the focused tab, including one restored after the run
// route was left and re-entered.
watch(
  () => browser.activeTab.value?.url,
  (url) => {
    addressDraft.value = url ?? ''
    const view = activeFrame()
    canGoBack.value = view?.canGoBack() ?? false
    canGoForward.value = view?.canGoForward() ?? false
  },
  { immediate: true }
)

function syncFrom(id: number): void {
  const view = frames.value[id]
  if (view === undefined || id !== browser.activeTabId.value) return
  canGoBack.value = view.canGoBack()
  canGoForward.value = view.canGoForward()
  browser.updateTab(id, { url: view.getURL() })
  addressDraft.value = view.getURL()
}

/** Navigates the focused tab, ignoring anything that is not a loopback address. */
function commitAddress(): void {
  const view = activeFrame()
  const candidate = addressDraft.value.trim()
  if (view === undefined || !isLoopbackAddress(candidate)) {
    addressDraft.value = browser.activeTab.value?.url ?? ''
    return
  }
  view.src = candidate
}

/** Clears the busy flag and re-reads navigation state once a load settles. */
function onStopLoading(id: number): void {
  loading.value = false
  syncFrom(id)
}

/** Tracks the guest element of one tab as Vue mounts and unmounts it. */
function registerFrame(id: number, element: unknown): void {
  if (element === null || element === undefined) {
    delete frames.value[id]
    return
  }
  frames.value[id] = element as RuntimeWebview
}

/** Records the page title the guest reports, so the tab strip stays truthful. */
function onTitleUpdated(id: number, event: unknown): void {
  const title = (event as { title?: unknown }).title
  if (typeof title === 'string' && title.length > 0) browser.updateTab(id, { title })
}

function reload(): void {
  if (loading.value) activeFrame()?.stop()
  else activeFrame()?.reload()
}
</script>

<template>
  <section class="browser-panel">
    <template v-if="browser.runtimeUrl.value">
      <div class="browser-tab-strip" role="tablist" :aria-label="t('runtime.title')">
        <button
          v-for="tab in browser.tabs"
          :key="tab.id"
          class="browser-tab"
          type="button"
          role="tab"
          :aria-selected="browser.activeTabId.value === tab.id"
          :data-active="browser.activeTabId.value === tab.id"
          :title="tab.url"
          :data-testid="`runtime-tab-${tab.id}`"
          @click="browser.activeTabId.value = tab.id"
        >
          <span class="browser-tab-title">{{ tab.title }}</span>
          <span
            class="browser-tab-close"
            role="button"
            tabindex="0"
            :aria-label="t('runtime.closeTab')"
            @click.stop="browser.closeTab(tab.id)"
            @keydown.enter.stop.prevent="browser.closeTab(tab.id)"
          >
            ×
          </span>
        </button>
        <button
          class="browser-tab-new"
          type="button"
          :aria-label="t('runtime.newTab')"
          :title="t('runtime.newTab')"
          data-testid="runtime-new-tab"
          @click="browser.openTab()"
        >
          +
        </button>
      </div>

      <div v-if="browser.activeTab.value" class="browser-bar">
        <button
          class="browser-icon-button"
          type="button"
          :disabled="!canGoBack"
          :aria-label="t('runtime.back')"
          data-testid="runtime-back"
          @click="activeFrame()?.goBack()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button
          class="browser-icon-button"
          type="button"
          :disabled="!canGoForward"
          :aria-label="t('runtime.forward')"
          data-testid="runtime-forward"
          @click="activeFrame()?.goForward()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
        <button
          class="browser-icon-button"
          type="button"
          :aria-label="loading ? t('runtime.stop') : t('runtime.reload')"
          data-testid="runtime-reload"
          @click="reload"
        >
          <svg v-if="loading" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v4h-4" />
          </svg>
        </button>
        <input
          v-model="addressDraft"
          class="browser-address"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :aria-label="t('runtime.url')"
          data-testid="runtime-address"
          @keydown.enter.prevent="commitAddress"
        />
      </div>

      <div class="browser-viewport-stack">
        <!-- Every open tab stays mounted and is merely hidden, so switching tabs
             keeps each page's own history and scroll position. -->
        <webview
          v-for="tab in browser.tabs"
          :key="tab.id"
          :ref="(element: unknown) => registerFrame(tab.id, element)"
          class="browser-viewport"
          :src="tab.url"
          :data-hidden="browser.activeTabId.value !== tab.id"
          :data-testid="`runtime-webview-${tab.id}`"
          @did-start-loading="loading = browser.activeTabId.value === tab.id"
          @did-stop-loading="onStopLoading(tab.id)"
          @did-navigate="syncFrom(tab.id)"
          @did-navigate-in-page="syncFrom(tab.id)"
          @page-title-updated="onTitleUpdated(tab.id, $event)"
        />
      </div>
      <EmptyState
        v-if="browser.tabs.length === 0"
        icon="window"
        fill
        :title="t('runtime.empty')"
        :description="t('runtime.empty.description')"
      >
        <template #actions>
          <button
            type="button"
            class="prototype-button prototype-button--primary"
            @click="browser.openTab()"
          >
            {{ t('runtime.newTab') }}
          </button>
        </template>
      </EmptyState>
    </template>
    <!--
      A route that reports "not running" without a way to start it leaves the
      user stranded on an otherwise blank surface.
    -->
    <EmptyState
      v-else
      icon="plug"
      fill
      :title="t('runtime.notRunning')"
      :description="t('runtime.notRunning.description')"
    >
      <template #actions>
        <button
          type="button"
          class="prototype-button prototype-button--primary"
          @click="emit('navigate', 'launch')"
        >
          {{ t('runtime.notRunning.action') }}
        </button>
      </template>
    </EmptyState>
  </section>
</template>

<style scoped>
.browser-panel {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.browser-tab-strip {
  display: flex;
  overflow-x: auto;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) 0;
  background: var(--color-surface);
}

.browser-tab {
  display: flex;
  max-width: 14rem;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius) var(--radius) 0 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  cursor: pointer;
}

.browser-tab[data-active='true'] {
  border-color: var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
}

.browser-tab:focus-visible,
.browser-tab-new:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.browser-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-tab-close {
  flex: none;
  padding: 0 var(--space-1);
  border-radius: 3px;
  color: var(--color-text-muted);
  line-height: 1;
  cursor: pointer;
}

.browser-tab-close:hover {
  background: var(--color-surface-raised);
  color: var(--color-text);
}

.browser-tab-new {
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--type-ui);
  line-height: 1;
  cursor: pointer;
}

.browser-tab-new:hover {
  background: var(--color-surface-raised);
  color: var(--color-text);
}

.browser-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.browser-icon-button {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  place-items: center;
}

.browser-icon-button:hover:not(:disabled) {
  background: var(--color-surface-raised);
  color: var(--color-text);
}

.browser-icon-button:disabled {
  opacity: 0.35;
  cursor: default;
}

.browser-icon-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.browser-icon-button svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}

.browser-address {
  flex: 1;
  min-width: 0;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--type-caption);
}

.browser-address:focus-visible {
  border-color: var(--color-accent);
  outline: none;
}

.browser-viewport-stack {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

.browser-viewport {
  position: absolute;
  display: flex;
  border: none;
  background: var(--color-bg);
  inset: 0;
}

.browser-viewport[data-hidden='true'] {
  visibility: hidden;
}
</style>
