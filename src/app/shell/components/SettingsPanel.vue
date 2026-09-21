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
  const trayApi = (
    window as unknown as { dshLauncher?: { tray?: { getCloseBehavior(): Promise<unknown> } } }
  ).dshLauncher?.tray
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

/*
 * Start-at-boot state for the native core.
 *
 * The switch reflects the core's own platform registration rather than a local
 * preference, so it is read on mount and re-read from every write: the same
 * registration can be changed by `dshkerd autostart` on the command line, and a
 * toggle that trusted its own last click would then show a state the machine does
 * not have. `supported` is false when no mechanism exists (or no core is running),
 * which disables the control instead of offering an action that cannot happen.
 */
const autostartInstalled = ref(false)
const autostartSupported = ref(false)
const autostartDesktopReadOnly = ref(false)
const autostartBusy = ref(false)
const autostartError = ref('')

interface AutostartBridge {
  getState(): Promise<unknown>
  setEnabled(enabled: boolean): Promise<unknown>
}

interface AutostartResult {
  readonly ok?: boolean
  readonly code?: string
  readonly message?: string
  readonly data?: { installed?: boolean; supported?: boolean; mechanism?: string }
}

function autostartApi(): AutostartBridge | undefined {
  return (window as unknown as { dshLauncher?: { autostart?: AutostartBridge } }).dshLauncher
    ?.autostart
}

/** Applies one answer, keeping the switch and the machine in agreement. */
function applyAutostart(result: unknown): void {
  const answer = result as AutostartResult
  if (answer?.ok !== true || answer.data === undefined) {
    autostartSupported.value = false
    autostartDesktopReadOnly.value = false
    // ApiResult failures are deliberately flat (`code` + `message`) across the
    // preload boundary. Reading a nested `error.message` here used to hide every
    // real core refusal behind the generic "could not be read" copy.
    autostartError.value =
      answer?.message === 'p2p.autostart_unavailable'
        ? t('settings.autostart.unavailable')
        : answer?.message === 'p2p.autostart_unsupported'
          ? t('settings.autostart.unsupported')
          : t('settings.autostart.failed')
    return
  }
  autostartError.value = ''
  autostartInstalled.value = answer.data.installed === true
  autostartSupported.value = answer.data.supported === true
  autostartDesktopReadOnly.value =
    answer.data.supported === false &&
    answer.data.mechanism !== undefined &&
    answer.data.mechanism !== 'unsupported'
}

async function readAutostart(): Promise<void> {
  const api = autostartApi()
  if (api === undefined) return
  if (autostartBusy.value) return
  autostartBusy.value = true
  try {
    applyAutostart(await api.getState())
  } catch {
    applyAutostart({ ok: false, message: 'p2p.autostart_unavailable' })
  } finally {
    autostartBusy.value = false
  }
}

onMounted(() => {
  void readAutostart()
})

async function updateAutostart(enabled: boolean): Promise<void> {
  const api = autostartApi()
  if (api === undefined || autostartBusy.value) return
  autostartBusy.value = true
  try {
    // Registering touches the filesystem and a platform tool, so the answer is
    // the state read back rather than the value that was requested.
    applyAutostart(await api.setEnabled(enabled))
  } catch {
    applyAutostart({ ok: false, message: 'p2p.autostart_unavailable' })
  } finally {
    autostartBusy.value = false
  }
}

async function updateTrayBehavior(behavior: 'minimize-to-tray' | 'quit'): Promise<void> {
  trayCloseBehavior.value = behavior
  const trayApi = (
    window as unknown as {
      dshLauncher?: { tray?: { setCloseBehavior(b: string): Promise<unknown> } }
    }
  ).dshLauncher?.tray
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
            <label
              class="settings-port-mode"
              :data-selected="trayCloseBehavior === 'minimize-to-tray'"
            >
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
            <h3>{{ t('settings.autostart') }}</h3>
            <p>{{ t('settings.autostart.hint') }}</p>
          </div>
        </header>
        <div class="settings-section-body">
          <label class="settings-autostart-toggle">
            <input
              type="checkbox"
              :checked="autostartInstalled"
              :disabled="!autostartSupported || autostartBusy"
              @change="updateAutostart(!autostartInstalled)"
            />
            <span class="settings-port-mode-copy">
              <strong>{{ t('settings.autostart.enable') }}</strong>
              <small v-if="autostartDesktopReadOnly">{{
                t('settings.autostart.desktopReadOnly')
              }}</small>
              <small v-else-if="!autostartSupported">{{
                t('settings.autostart.unsupported')
              }}</small>
              <small v-else>{{ t('settings.autostart.enable.description') }}</small>
            </span>
          </label>
          <div v-if="autostartError" class="settings-autostart-feedback">
            <p class="settings-autostart-error" role="status">{{ autostartError }}</p>
            <button
              class="prototype-button prototype-button--secondary"
              type="button"
              :disabled="autostartBusy"
              @click="readAutostart"
            >
              {{ t('settings.autostart.retry') }}
            </button>
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
