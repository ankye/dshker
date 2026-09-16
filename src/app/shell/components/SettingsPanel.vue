<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { LauncherUpdateSettingsCard } from '@/app/domains/launcher-updates'
import { ManagedWorkspacesPanel } from '@/app/domains/managed-workspaces'
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/app/shared/i18n/i18n'
import { locale, setLocale, useTranslator } from '@/app/shared/i18n/useLocale'
import { setTheme, theme, type Theme } from '@/app/shared/theme/useTheme'
import { LAUNCHER_HARNESS_MAX_PORT, LAUNCHER_HARNESS_MIN_PORT } from '@/shared/contracts'

const t = useTranslator()

/** Tray close-behaviour setting, loaded on mount. */
const trayCloseBehavior = ref<'minimize-to-tray' | 'quit'>('minimize-to-tray')

onMounted(async () => {
  const trayApi = (window as unknown as { dshLauncher?: { tray?: { getCloseBehavior(): Promise<unknown> } } })
    .dshLauncher?.tray
  if (trayApi) {
    const result = (await trayApi.getCloseBehavior()) as {
      ok: boolean
      data?: { closeBehavior: string }
    }
    if (result.ok && result.data) {
      const behavior = result.data.closeBehavior
      if (behavior === 'minimize-to-tray' || behavior === 'quit') {
        trayCloseBehavior.value = behavior
      }
    }
  }
})

async function updateTrayBehavior(behavior: 'minimize-to-tray' | 'quit'): Promise<void> {
  trayCloseBehavior.value = behavior
  const trayApi = (window as unknown as { dshLauncher?: { tray?: { setCloseBehavior(b: string): Promise<unknown> } } })
    .dshLauncher?.tray
  if (trayApi) await trayApi.setCloseBehavior(behavior)
}

/**
 * The control edits shared app state rather than owning it. While this route
 * owned the theme, the persisted choice only took effect once Settings had been
 * opened.
 */
const selectedTheme = computed<Theme>({
  get: () => theme.selected.value,
  set: (value) => setTheme(value)
})

const settingsTab = ref<'dsh' | 'launcher'>('dsh')
const harness = useLauncherHarness()
const portMode = ref<'auto' | 'fixed'>('auto')
const portDraft = ref('')
const persistedPort = computed(() => harness.state.value?.port)

/** Short summary of the persisted port choice, shown in the group header. */
const portStatus = computed(() => {
  const current = persistedPort.value
  if (!current) return undefined
  if (current.mode === 'fixed' && current.port)
    return `${t('managed.port.fixed')} · ${current.port}`
  return t('managed.port.auto')
})

watch(
  persistedPort,
  (value) => {
    if (!value) return
    portMode.value = value.mode
    portDraft.value = value.mode === 'fixed' ? String(value.port) : ''
  },
  { immediate: true }
)

const portError = computed(() => {
  if (portMode.value === 'auto') return undefined
  if (!/^\d+$/u.test(portDraft.value)) return t('managed.port.errorFormat')
  const port = Number(portDraft.value)
  if (port < LAUNCHER_HARNESS_MIN_PORT || port > LAUNCHER_HARNESS_MAX_PORT) {
    return t('managed.port.errorRange')
  }
  return undefined
})

const canApplyPort = computed(() => {
  if (portError.value !== undefined || harness.loading.value) return false
  const current = persistedPort.value
  if (!current) return false
  if (portMode.value === 'auto') return current.mode !== 'auto'
  return current.mode !== 'fixed' || current.port !== Number(portDraft.value)
})

async function applyPort(): Promise<void> {
  if (!canApplyPort.value) return
  await harness.setPort({
    port:
      portMode.value === 'auto'
        ? { mode: 'auto' }
        : { mode: 'fixed', port: Number(portDraft.value) }
  })
}

const themeOptions = computed<readonly ThemedListboxOption<Theme>[]>(() => [
  { value: 'system', label: t('settings.theme.system') },
  { value: 'dark', label: t('settings.theme.dark') },
  { value: 'light', label: t('settings.theme.light') }
])

const localeOptions = computed(() =>
  SUPPORTED_LOCALES.map((entry) => ({ value: entry.locale, label: entry.label }))
)

/** Writes through to the shared locale state so every surface re-renders at once. */
const selectedLocale = computed<SupportedLocale>({
  get: () => locale.value,
  set: (value) => setLocale(value)
})
</script>

<template>
  <section class="settings-panel">
    <div class="settings-tabs" role="tablist" :aria-label="t('settings.title')">
      <button
        class="page-tab"
        :data-active="settingsTab === 'dsh'"
        :aria-selected="settingsTab === 'dsh'"
        role="tab"
        type="button"
        @click="settingsTab = 'dsh'"
      >
        {{ t('settings.dsh') }}
      </button>
      <button
        class="page-tab"
        :data-active="settingsTab === 'launcher'"
        :aria-selected="settingsTab === 'launcher'"
        role="tab"
        type="button"
        @click="settingsTab = 'launcher'"
      >
        {{ t('settings.launcher') }}
      </button>
    </div>

    <div v-if="settingsTab === 'dsh'" class="settings-tab-panel">
      <section class="settings-section">
        <header class="settings-section-header">
          <div class="settings-section-title">
            <h3>{{ t('settings.dsh.web.title') }}</h3>
            <p>{{ t('settings.dsh.web.description') }}</p>
          </div>
          <span v-if="portStatus" class="settings-section-meta">{{ portStatus }}</span>
        </header>

        <form
          v-if="persistedPort"
          class="settings-section-body settings-dsh-port-form"
          @submit.prevent="applyPort"
        >
          <div class="settings-port-modes" role="radiogroup" :aria-label="t('managed.port.title')">
            <label class="settings-port-mode" :data-selected="portMode === 'auto'">
              <input v-model="portMode" type="radio" value="auto" name="dsh-port-mode" />
              <span class="settings-port-mode-copy">
                <strong>{{ t('managed.port.auto') }}</strong>
                <small>{{ t('managed.port.autoDescription') }}</small>
              </span>
            </label>
            <label class="settings-port-mode" :data-selected="portMode === 'fixed'">
              <input v-model="portMode" type="radio" value="fixed" name="dsh-port-mode" />
              <span class="settings-port-mode-copy">
                <strong>{{ t('managed.port.fixed') }}</strong>
                <small>{{ t('managed.port.fixedDescription') }}</small>
              </span>
            </label>
          </div>

          <div class="settings-port-detail" :data-inactive="portMode === 'auto'">
            <label class="settings-port-field">
              <span>{{ t('managed.port.label') }}</span>
              <input
                v-model="portDraft"
                :disabled="portMode === 'auto'"
                :aria-invalid="portError !== undefined"
                :placeholder="t('managed.port.placeholder')"
                autocomplete="off"
                data-testid="settings-dsh-port-input"
                inputmode="numeric"
                name="dsh-port"
              />
            </label>
            <p v-if="portError" class="settings-port-error" role="alert">{{ portError }}</p>
            <p v-else class="settings-port-hint">{{ t('managed.port.restartHint') }}</p>
          </div>

          <footer class="settings-section-actions">
            <button
              class="prototype-button prototype-button--primary"
              type="submit"
              :disabled="!canApplyPort"
              data-testid="settings-apply-dsh-port"
            >
              {{ t('managed.port.apply') }}
            </button>
          </footer>
        </form>
        <p v-else class="settings-section-body settings-dsh-unavailable" role="status">
          {{ t('settings.dsh.web.unavailable') }}
        </p>
      </section>

      <p class="settings-dsh-ownership">{{ t('settings.dsh.ownership') }}</p>
    </div>

    <div v-else class="settings-tab-panel settings-tab-panel--split">
      <LauncherUpdateSettingsCard />

      <section class="settings-section">
        <header class="settings-section-header">
          <div class="settings-section-title">
            <h3>{{ t('settings.appearance') }}</h3>
          </div>
        </header>
        <div class="settings-section-body settings-list">
          <div class="settings-row">
            <span class="settings-row-copy">
              <strong>{{ t('settings.theme') }}</strong>
              <small>{{ t('settings.theme.hint') }}</small>
            </span>
            <ThemedListbox
              v-model="selectedTheme"
              :options="themeOptions"
              :label="t('settings.theme')"
              test-id="settings-theme"
            />
          </div>
          <div class="settings-row">
            <span class="settings-row-copy">
              <strong>{{ t('settings.language') }}</strong>
              <small>{{ t('settings.language.hint') }}</small>
            </span>
            <ThemedListbox
              v-model="selectedLocale"
              :options="localeOptions"
              :label="t('settings.language')"
              test-id="settings-language"
            />
          </div>
        </div>
      </section>

      <section class="settings-section">
        <header class="settings-section-header">
          <div class="settings-section-title">
            <h3>{{ t('settings.tray') }}</h3>
            <p>{{ t('settings.tray.hint') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <div class="settings-port-modes" role="radiogroup" :aria-label="t('settings.tray')">
            <label class="settings-port-mode" :data-selected="trayCloseBehavior === 'minimize-to-tray'">
              <input
                v-model="trayCloseBehavior"
                type="radio"
                value="minimize-to-tray"
                name="launcher-close-behavior"
                @change="updateTrayBehavior('minimize-to-tray')"
              />
              <span class="settings-port-mode-copy">
                <strong>{{ t('settings.tray.minimize') }}</strong>
                <small>{{ t('settings.tray.minimize.description') }}</small>
              </span>
            </label>
            <label class="settings-port-mode" :data-selected="trayCloseBehavior === 'quit'">
              <input
                v-model="trayCloseBehavior"
                type="radio"
                value="quit"
                name="launcher-close-behavior"
                @change="updateTrayBehavior('quit')"
              />
              <span class="settings-port-mode-copy">
                <strong>{{ t('settings.tray.quit') }}</strong>
                <small>{{ t('settings.tray.quit.description') }}</small>
              </span>
            </label>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <header class="settings-section-header">
          <div class="settings-section-title">
            <h3>{{ t('settings.launcher.management') }}</h3>
          </div>
        </header>
        <div class="settings-section-body">
          <ManagedWorkspacesPanel :show-installations="false" :show-port="false" :embedded="true" />
        </div>
      </section>
    </div>
  </section>
</template>
