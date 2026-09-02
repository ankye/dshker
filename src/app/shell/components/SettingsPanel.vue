<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { CopyPathButton, ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/app/shared/i18n/i18n'
import { locale, setLocale, useTranslator } from '@/app/shared/i18n/useLocale'
import { setTheme, theme, type Theme } from '@/app/shared/theme/useTheme'
import { useManagedWorkspaces } from '@/app/domains/managed-workspaces'

const t = useTranslator()

/**
 * The control edits shared app state rather than owning it. While this route
 * owned the theme, the persisted choice only took effect once Settings had been
 * opened.
 */
const selectedTheme = computed<Theme>({
  get: () => theme.selected.value,
  set: (value) => setTheme(value)
})

const managed = useManagedWorkspaces()
onMounted(() => {
  void managed.initialize()
})
/** Canonical path of the registered settings root, absent until registration. */
const settingsRootPath = computed(
  () => managed.orderedRoots.value.find((root) => root.kind === 'settings')?.canonicalPath
)

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
      <button class="page-tab" :data-active="true" aria-selected="true" role="tab" type="button">
        {{ t('settings.general') }}
      </button>
    </div>

    <h3>{{ t('settings.appearance') }}</h3>
    <div class="settings-list">
      <div class="settings-row">
        <span>
          <strong>{{ t('settings.theme') }}</strong>
          <!-- Describes what the setting does; the listbox already shows its
               own current value, so repeating it said the same thing twice. -->
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
        <span>
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

    <h3>{{ t('settings.storage') }}</h3>
    <div class="settings-list">
      <div class="settings-row">
        <span>
          <strong>{{ t('settings.sourceRoot') }}</strong>
          <!--
            Carries the registered path instead of repeating the route
            description verbatim; an unregistered root says so.
          -->
          <span v-if="settingsRootPath" class="settings-row-path-line">
            <code class="settings-row-path" :title="settingsRootPath">{{ settingsRootPath }}</code>
            <CopyPathButton :value="settingsRootPath" />
          </span>
          <small v-else>{{ t('settings.sourceRoot.unregistered') }}</small>
        </span>
      </div>
    </div>
  </section>
</template>
