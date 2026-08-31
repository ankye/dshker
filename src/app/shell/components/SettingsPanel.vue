<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ThemedListbox, type ThemedListboxOption } from '@/app/shared/controls'
import { SUPPORTED_LOCALES, INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'

type Theme = 'system' | 'dark' | 'light'

const t = createTranslator(INITIAL_LOCALE)
const theme = ref<Theme>('dark')
const locale = ref(INITIAL_LOCALE)
const npmMirror = ref(false)
const themeLabel = computed(() => t(`settings.theme.${theme.value}`))

const themeOptions = computed<readonly ThemedListboxOption<Theme>[]>(() => [
  { value: 'system', label: t('settings.theme.system') },
  { value: 'dark', label: t('settings.theme.dark') },
  { value: 'light', label: t('settings.theme.light') }
])

const localeOptions = computed(() =>
  SUPPORTED_LOCALES.map((entry) => ({ value: entry.locale, label: entry.label }))
)

watch(theme, (value) => {
  document.documentElement.dataset.theme = value
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
          <small>{{ themeLabel }}</small>
        </span>
        <ThemedListbox
          v-model="theme"
          :options="themeOptions"
          :label="t('settings.theme')"
          test-id="settings-theme"
        />
      </div>
      <div class="settings-row">
        <span>
          <strong>{{ t('settings.language') }}</strong>
          <small>{{ SUPPORTED_LOCALES.find((entry) => entry.locale === locale)?.label }}</small>
        </span>
        <ThemedListbox
          v-model="locale"
          :options="localeOptions"
          :label="t('settings.language')"
          test-id="settings-language"
        />
      </div>
    </div>

    <h3>{{ t('settings.network') }}</h3>
    <div class="settings-list">
      <label class="settings-row settings-row--toggle">
        <span>
          <strong>{{ t('settings.npmMirror') }}</strong>
          <small>{{ t('settings.npmMirror.description') }}</small>
        </span>
        <input v-model="npmMirror" class="toggle-input" type="checkbox" />
      </label>
      <div class="settings-row">
        <span>
          <strong>{{ t('settings.sourceRoot') }}</strong>
          <small>{{ t('settings.description') }}</small>
        </span>
      </div>
    </div>
  </section>
</template>
