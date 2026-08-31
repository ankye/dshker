<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'

interface RuntimeTab {
  readonly id: number
  readonly title: string
}

const t = createTranslator(INITIAL_LOCALE)
const { state } = useLauncherHarness()
const tabs = ref<readonly RuntimeTab[]>([])
const activeTabId = ref<number>()
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value))

/**
 * The only address a run page may load is the one the started DSH process
 * announced. The Launcher never predicts a port or rebuilds a loopback URL,
 * because `dsh web` selects its own port and may embed a session credential.
 */
const runtimeUrl = computed(() => {
  const launch = state.value?.launch
  return launch?.kind === 'running' ? launch.url : undefined
})

// A page for a stopped runtime would show a dead frame, so tabs close with it.
watch(runtimeUrl, (url) => {
  if (url !== undefined) return
  tabs.value = []
  activeTabId.value = undefined
})

function createTab(): void {
  if (runtimeUrl.value === undefined) return
  const id = Date.now()
  tabs.value = [...tabs.value, { id, title: t('runtime.defaultTitle') }]
  activeTabId.value = id
}
</script>

<template>
  <section class="runtime-tabs-panel">
    <header class="runtime-toolbar">
      <div class="runtime-tab-strip" role="tablist" :aria-label="t('runtime.title')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="runtime-tab"
          :aria-selected="activeTabId === tab.id"
          :data-active="activeTabId === tab.id"
          role="tab"
          type="button"
          @click="activeTabId = tab.id"
        >
          {{ tab.title }}
        </button>
      </div>
      <button
        class="prototype-button prototype-button--primary"
        type="button"
        :disabled="runtimeUrl === undefined"
        @click="createTab"
      >
        {{ t('runtime.newTab') }}
      </button>
    </header>
    <section v-if="activeTab && runtimeUrl" class="runtime-frame-panel">
      <label class="runtime-url-field">
        <span>{{ t('runtime.url') }}</span>
        <input :value="runtimeUrl" readonly />
      </label>
      <iframe
        :key="activeTab.id"
        class="runtime-frame"
        :src="runtimeUrl"
        :title="activeTab.title"
      />
    </section>
    <section v-else class="runtime-empty">
      <p>{{ runtimeUrl === undefined ? t('runtime.notRunning') : t('runtime.empty') }}</p>
      <button
        class="prototype-button prototype-button--primary"
        type="button"
        :disabled="runtimeUrl === undefined"
        @click="createTab"
      >
        {{ t('runtime.newTab') }}
      </button>
    </section>
  </section>
</template>
