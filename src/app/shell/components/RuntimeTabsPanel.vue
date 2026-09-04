<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRuntimeBrowser } from '@/app/domains/runtime-browser'
import {
  RUNTIME_GUEST_RENDERING_PROBE,
  parseRuntimeGuestRenderingInfo,
  type RuntimeGuestRenderingInfo
} from '@/app/domains/runtime-browser/renderingDiagnostics'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import {
  RUNTIME_BROWSER_ZOOM_PERCENTAGES,
  type RuntimeBrowserHostRenderingInfo
} from '@/shared/contracts'
import {
  nextRuntimeBrowserZoom,
  runtimeBrowserZoomCommandForInput,
  type RuntimeBrowserZoomCommand
} from '@/shared/runtime-browser-zoom'
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
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  executeJavaScript(code: string): Promise<unknown>
}

interface RuntimeRenderingSnapshot {
  readonly host: RuntimeBrowserHostRenderingInfo
  readonly guest: RuntimeGuestRenderingInfo
  readonly hostDevicePixelRatio: number
  readonly guestZoomFactor: number
}

const t = useTranslator()
const browser = runtimeBrowser
const runtime = useRuntimeBrowser()

/** Routing belongs to the shell, so a stopped runtime asks it to move. */
const emit = defineEmits<{ navigate: ['launch'] }>()
const frames = ref<Record<number, RuntimeWebview | undefined>>({})
const addressDraft = ref('')
const loading = ref(false)
const canGoBack = ref(false)
const canGoForward = ref(false)
const readyFrames = ref<Record<number, boolean | undefined>>({})
const diagnosticsOpen = ref(false)
const diagnosticsLoading = ref(false)
const diagnosticsUnavailable = ref(false)
const diagnosticsCopied = ref(false)
const diagnosticsCopyFailed = ref(false)
const renderingSnapshot = ref<RuntimeRenderingSnapshot>()
let dprMediaQuery: MediaQueryList | undefined

const zoomPercent = computed(() => runtime.preferences.value?.zoomPercent)
const zoomAtMinimum = computed(() => zoomPercent.value === RUNTIME_BROWSER_ZOOM_PERCENTAGES[0])
const zoomAtMaximum = computed(() => zoomPercent.value === RUNTIME_BROWSER_ZOOM_PERCENTAGES.at(-1))

const renderingRows = computed<readonly { readonly label: string; readonly value: string }[]>(
  () => {
    const snapshot = renderingSnapshot.value
    if (snapshot === undefined) return []
    return [
      { label: t('runtime.rendering.electron'), value: snapshot.host.electronVersion },
      { label: t('runtime.rendering.chromium'), value: snapshot.host.chromiumVersion },
      {
        label: t('runtime.rendering.displayScale'),
        value: formatScale(snapshot.host.displayScaleFactor)
      },
      { label: t('runtime.rendering.hostDpr'), value: formatScale(snapshot.hostDevicePixelRatio) },
      {
        label: t('runtime.rendering.guestDpr'),
        value: formatScale(snapshot.guest.devicePixelRatio)
      },
      {
        label: t('runtime.rendering.pageZoom'),
        value: `${Math.round(snapshot.guestZoomFactor * 100)}%`
      },
      {
        label: t('runtime.rendering.viewportScale'),
        value: formatOptionalScale(snapshot.guest.visualViewportScale)
      },
      { label: t('runtime.rendering.colorSpace'), value: snapshot.host.displayColorSpace },
      { label: t('runtime.rendering.colorScheme'), value: snapshot.guest.colorScheme },
      { label: t('runtime.rendering.gpuCompositing'), value: snapshot.host.gpuCompositing },
      { label: t('runtime.rendering.rasterization'), value: snapshot.host.rasterization },
      {
        label: t('runtime.rendering.rasterThreads'),
        value: snapshot.host.multipleRasterThreads
      },
      {
        label: t('runtime.rendering.font'),
        value: formatOptionalValue(snapshot.guest.fontFamily)
      },
      {
        label: t('runtime.rendering.fontSize'),
        value: formatOptionalValue(snapshot.guest.fontSize)
      },
      {
        label: t('runtime.rendering.fontSmoothing'),
        value:
          snapshot.guest.fontSmoothing === null
            ? t('runtime.rendering.unavailableValue')
            : snapshot.guest.fontSmoothing || t('runtime.rendering.unset')
      },
      {
        label: t('runtime.rendering.textColor'),
        value: formatOptionalValue(snapshot.guest.textColor)
      },
      {
        label: t('runtime.rendering.background'),
        value: `${snapshot.guest.rootBackgroundColor} / ${formatOptionalValue(snapshot.guest.bodyBackgroundColor)}`
      }
    ]
  }
)

/** The guest element of the focused tab, when it is mounted. */
function activeFrame(): RuntimeWebview | undefined {
  const id = browser.activeTabId.value
  return id === undefined ? undefined : frames.value[id]
}

// Tab lifecycle follows the runtime at module level: a fresh launch opens its
// first page automatically, and stopping the runtime closes every tab.

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
    delete readyFrames.value[id]
    return
  }
  frames.value[id] = element as RuntimeWebview
}

/** Applies the persisted page zoom once the guest DOM can receive WebView methods. */
function onDomReady(id: number): void {
  readyFrames.value[id] = true
  applyZoom(frames.value[id])
  if (id === browser.activeTabId.value && diagnosticsOpen.value) void refreshDiagnostics()
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

/** Requests one fixed adjacent step; persistence succeeds before the UI adopts it. */
async function changeZoom(command: RuntimeBrowserZoomCommand): Promise<void> {
  const current = zoomPercent.value
  if (current === undefined) return
  await runtime.setZoom(nextRuntimeBrowserZoom(current, command))
}

function applyZoom(frame: RuntimeWebview | undefined): void {
  const percent = zoomPercent.value
  if (frame === undefined || percent === undefined) return
  frame.setZoomFactor(percent / 100)
}

watch(zoomPercent, () => {
  for (const [id, frame] of Object.entries(frames.value)) {
    if (readyFrames.value[Number(id)]) applyZoom(frame)
  }
})

watch(
  () => browser.activeTabId.value,
  () => {
    renderingSnapshot.value = undefined
    diagnosticsUnavailable.value = false
    if (diagnosticsOpen.value) void refreshDiagnostics()
  }
)

function hostPlatform(): NodeJS.Platform | undefined {
  const userAgent = navigator.userAgent
  if (userAgent.includes('Macintosh')) return 'darwin'
  if (userAgent.includes('Windows')) return 'win32'
  if (userAgent.includes('Linux')) return 'linux'
  return undefined
}

/** Handles shortcuts while focus remains in the Launcher chrome. */
function onHostKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && diagnosticsOpen.value) {
    diagnosticsOpen.value = false
    return
  }
  const platform = hostPlatform()
  if (platform === undefined) return
  const command = runtimeBrowserZoomCommandForInput(
    {
      type: 'keyDown',
      key: event.key,
      code: event.code,
      isComposing: event.isComposing,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey
    },
    platform
  )
  if (command === undefined) return
  event.preventDefault()
  void changeZoom(command)
}

/** Re-samples current host and guest rendering facts without reading page identity or content. */
async function refreshDiagnostics(): Promise<void> {
  const frame = activeFrame()
  if (
    frame === undefined ||
    browser.activeTabId.value === undefined ||
    !readyFrames.value[browser.activeTabId.value]
  ) {
    renderingSnapshot.value = undefined
    diagnosticsUnavailable.value = true
    return
  }
  diagnosticsLoading.value = true
  diagnosticsUnavailable.value = false
  diagnosticsCopied.value = false
  diagnosticsCopyFailed.value = false
  try {
    const [host, rawGuest] = await Promise.all([
      runtime.getHostRenderingInfo(),
      frame.executeJavaScript(RUNTIME_GUEST_RENDERING_PROBE)
    ])
    const guestZoomFactor = frame.getZoomFactor()
    const hostDevicePixelRatio = window.devicePixelRatio
    if (
      host === undefined ||
      !Number.isFinite(guestZoomFactor) ||
      guestZoomFactor <= 0 ||
      !Number.isFinite(hostDevicePixelRatio) ||
      hostDevicePixelRatio <= 0
    ) {
      throw new Error('Runtime rendering facts are unavailable.')
    }
    renderingSnapshot.value = {
      host,
      guest: parseRuntimeGuestRenderingInfo(rawGuest),
      hostDevicePixelRatio,
      guestZoomFactor
    }
  } catch {
    renderingSnapshot.value = undefined
    diagnosticsUnavailable.value = true
  } finally {
    diagnosticsLoading.value = false
  }
}

async function toggleDiagnostics(): Promise<void> {
  diagnosticsOpen.value = !diagnosticsOpen.value
  if (diagnosticsOpen.value) await refreshDiagnostics()
}

async function copyDiagnostics(): Promise<void> {
  if (renderingRows.value.length === 0) return
  try {
    await navigator.clipboard.writeText(
      [
        t('runtime.rendering.title'),
        ...renderingRows.value.map((row) => `${row.label}: ${row.value}`)
      ].join('\n')
    )
    diagnosticsCopied.value = true
    diagnosticsCopyFailed.value = false
  } catch {
    diagnosticsCopied.value = false
    diagnosticsCopyFailed.value = true
  }
}

function formatScale(value: number): string {
  return `${value.toFixed(2).replace(/\.00$/u, '')}×`
}

function formatOptionalScale(value: number | null): string {
  return value === null ? t('runtime.rendering.unavailableValue') : formatScale(value)
}

function formatOptionalValue(value: string | null): string {
  return value === null ? t('runtime.rendering.unavailableValue') : value
}

function observeDevicePixelRatio(): void {
  dprMediaQuery?.removeEventListener('change', onDevicePixelRatioChange)
  dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  dprMediaQuery.addEventListener('change', onDevicePixelRatioChange, { once: true })
}

function onDevicePixelRatioChange(): void {
  observeDevicePixelRatio()
  if (diagnosticsOpen.value) void refreshDiagnostics()
}

onMounted(() => {
  window.addEventListener('keydown', onHostKeydown)
  observeDevicePixelRatio()
})

onUnmounted(() => {
  window.removeEventListener('keydown', onHostKeydown)
  dprMediaQuery?.removeEventListener('change', onDevicePixelRatioChange)
})
</script>

<template>
  <section class="browser-panel">
    <template v-if="browser.runtimeUrl.value">
      <EmptyState
        v-if="runtime.preferences.value === undefined"
        icon="window"
        fill
        :title="
          runtime.loading.value
            ? t('runtime.preferences.loading')
            : t('runtime.preferences.blocked')
        "
        :description="
          runtime.loading.value
            ? t('runtime.preferences.loading.description')
            : t('runtime.preferences.blocked.description')
        "
      >
        <template v-if="!runtime.loading.value" #actions>
          <button
            type="button"
            class="prototype-button prototype-button--primary"
            @click="runtime.refresh()"
          >
            {{ t('runtime.preferences.retry') }}
          </button>
        </template>
      </EmptyState>
      <template v-else>
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
          <div class="browser-zoom-control" role="group" :aria-label="t('runtime.zoom')">
            <button
              type="button"
              :disabled="zoomAtMinimum || runtime.saving.value"
              :aria-label="t('runtime.zoom.decrease')"
              :title="t('runtime.zoom.decrease')"
              data-testid="runtime-zoom-decrease"
              @click="changeZoom('decrease')"
            >
              −
            </button>
            <button
              class="browser-zoom-value"
              type="button"
              :disabled="runtime.saving.value"
              :aria-label="t('runtime.zoom.reset')"
              :title="t('runtime.zoom.reset')"
              data-testid="runtime-zoom-reset"
              @click="changeZoom('reset')"
            >
              {{ zoomPercent }}%
            </button>
            <button
              type="button"
              :disabled="zoomAtMaximum || runtime.saving.value"
              :aria-label="t('runtime.zoom.increase')"
              :title="t('runtime.zoom.increase')"
              data-testid="runtime-zoom-increase"
              @click="changeZoom('increase')"
            >
              +
            </button>
          </div>
          <div class="browser-rendering-control">
            <button
              class="browser-icon-button"
              type="button"
              :aria-expanded="diagnosticsOpen"
              :aria-label="t('runtime.rendering.open')"
              :title="t('runtime.rendering.open')"
              data-testid="runtime-rendering-info"
              @click="toggleDiagnostics"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 10v6M12 7h.01" />
              </svg>
            </button>
            <section
              v-if="diagnosticsOpen"
              class="browser-rendering-popover"
              role="dialog"
              :aria-label="t('runtime.rendering.title')"
              data-testid="runtime-rendering-popover"
            >
              <header>
                <div>
                  <h3>{{ t('runtime.rendering.title') }}</h3>
                  <p>{{ t('runtime.rendering.description') }}</p>
                </div>
                <button
                  class="browser-icon-button"
                  type="button"
                  :aria-label="t('runtime.rendering.close')"
                  @click="diagnosticsOpen = false"
                >
                  ×
                </button>
              </header>
              <p v-if="diagnosticsLoading" class="browser-rendering-status">
                {{ t('runtime.rendering.loading') }}
              </p>
              <p v-else-if="diagnosticsUnavailable" class="browser-rendering-status" role="alert">
                {{ t('runtime.rendering.unavailable') }}
              </p>
              <dl v-else class="browser-rendering-grid">
                <template v-for="row in renderingRows" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd>{{ row.value }}</dd>
                </template>
              </dl>
              <footer>
                <button
                  type="button"
                  class="prototype-button"
                  :disabled="diagnosticsLoading"
                  @click="refreshDiagnostics"
                >
                  {{ t('runtime.rendering.refresh') }}
                </button>
                <button
                  type="button"
                  class="prototype-button prototype-button--primary"
                  :disabled="renderingRows.length === 0"
                  @click="copyDiagnostics"
                >
                  {{
                    diagnosticsCopied ? t('runtime.rendering.copied') : t('runtime.rendering.copy')
                  }}
                </button>
              </footer>
              <p v-if="diagnosticsCopyFailed" class="browser-rendering-copy-error" role="alert">
                {{ t('runtime.rendering.copyFailed') }}
              </p>
            </section>
          </div>
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
            @dom-ready="onDomReady(tab.id)"
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
  overflow: hidden;
}

/* Browser chrome stays compact so the DSH page owns the visual canvas. */
.browser-tab-strip {
  display: flex;
  min-width: 0;
  align-items: flex-end;
  gap: 0.125rem;
  padding: var(--space-2) var(--space-3) 0;
  overflow-x: auto;
  background: transparent;
}

.browser-tab {
  position: relative;
  display: flex;
  max-width: 13rem;
  min-width: 0;
  align-items: center;
  gap: var(--space-2);
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: var(--radius) var(--radius) 0 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--type-caption);
  cursor: pointer;
}

.browser-tab:hover {
  background: color-mix(in srgb, var(--color-text), transparent 94%);
  color: var(--color-text);
}

/* The active tab opens downward into the framed page, so its bottom edge is
 * square and its top corners rounded — the classic connected-tab shape. */
.browser-tab[data-active='true'] {
  background: var(--color-bg);
  color: var(--color-text);
}

.browser-tab[data-active='true']::after {
  position: absolute;
  top: 0.15rem;
  right: 0.15rem;
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: var(--color-accent);
  content: '';
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

/* The close control appears on hover or focus instead of permanently crowding
 * narrow tabs, and the active tab keeps it dimmed until hovered. */
.browser-tab-close {
  flex: none;
  margin-right: -0.25rem;
  padding: 0 0.25rem;
  border-radius: 3px;
  color: var(--color-text-muted);
  font-size: var(--type-ui);
  line-height: 1.4;
  opacity: 0;
  cursor: pointer;
}

.browser-tab:hover .browser-tab-close,
.browser-tab:focus-within .browser-tab-close,
.browser-tab[data-active='true'] .browser-tab-close {
  opacity: 1;
}

.browser-tab-close:hover {
  background: var(--color-surface-raised);
  color: var(--color-text);
}

.browser-tab-new {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  flex: none;
  margin-left: 0.25rem;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--type-ui);
  line-height: 1;
  cursor: pointer;
  place-items: center;
}

.browser-tab-new:hover {
  background: color-mix(in srgb, var(--color-text), transparent 94%);
  color: var(--color-text);
}

.browser-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: transparent;
  z-index: 2;
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
  background: color-mix(in srgb, var(--color-text), transparent 94%);
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
  padding: 0.375rem var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-surface-raised), var(--color-bg) 40%);
  color: var(--color-text);
  font-size: var(--type-caption);
  transition: border-color var(--motion-fast) var(--ease-standard);
}

.browser-address:focus-visible {
  border-color: var(--color-accent);
  outline: none;
}

.browser-zoom-control {
  display: flex;
  height: 1.75rem;
  flex: none;
  align-items: stretch;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
  background: color-mix(in srgb, var(--color-surface-raised), var(--color-bg) 40%);
}

.browser-zoom-control button {
  min-width: 1.75rem;
  padding: 0 0.4rem;
  border: none;
  border-right: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.browser-zoom-control button:last-child {
  border-right: none;
}

.browser-zoom-control button:hover:not(:disabled),
.browser-zoom-control button:focus-visible {
  background: color-mix(in srgb, var(--color-accent), transparent 88%);
  color: var(--color-text);
  outline: none;
}

.browser-zoom-control button:disabled {
  color: color-mix(in srgb, var(--color-text-muted), transparent 42%);
  cursor: default;
}

.browser-zoom-control .browser-zoom-value {
  min-width: 3.35rem;
  color: var(--color-text);
  font-size: var(--type-caption);
  font-variant-numeric: tabular-nums;
}

.browser-rendering-control {
  position: relative;
  flex: none;
}

.browser-rendering-popover {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  display: flex;
  width: min(30rem, calc(100vw - 4rem));
  max-height: min(36rem, calc(100vh - 10rem));
  flex-direction: column;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: auto;
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-float);
  color: var(--color-text);
  z-index: 4;
}

.browser-rendering-popover header,
.browser-rendering-popover footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.browser-rendering-popover h3,
.browser-rendering-popover p {
  margin: 0;
}

.browser-rendering-popover h3 {
  font-size: var(--type-ui);
}

.browser-rendering-popover header p,
.browser-rendering-status {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--type-caption);
}

.browser-rendering-grid {
  display: grid;
  grid-template-columns: minmax(7.5rem, auto) minmax(0, 1fr);
  gap: 0;
  margin: var(--space-4) 0;
  border-top: 1px solid var(--color-border);
}

.browser-rendering-grid dt,
.browser-rendering-grid dd {
  min-width: 0;
  margin: 0;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--color-border);
  font-size: var(--type-caption);
}

.browser-rendering-grid dt {
  color: var(--color-text-muted);
}

.browser-rendering-grid dd {
  overflow-wrap: anywhere;
  color: var(--color-text);
  font-family: var(--font-mono);
}

.browser-rendering-popover footer {
  justify-content: flex-end;
}

.browser-rendering-copy-error {
  margin-top: var(--space-2) !important;
  color: var(--color-danger);
  font-size: var(--type-caption);
}

/* The guest fills every remaining pixel. DPR and page zoom stay in Chromium's
 * raster pipeline; no CSS transform, filter, opacity, or zoom is applied. */
.browser-viewport-stack {
  position: relative;
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background: var(--color-bg);
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
