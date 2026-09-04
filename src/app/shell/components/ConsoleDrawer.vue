<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { harnessConsole } from '@/app/domains/launcher-harness'
import { useConsoleDrawer } from '../consoleDrawerState'
import { useTranslator } from '@/app/shared/i18n/useLocale'

/**
 * The shell-level read-only tail of Launcher activity.
 *
 * Every route can start a long operation; the drawer keeps its output one
 * glance away without navigating. Full fidelity (copy, export, reveal) stays
 * on the Console route — the drawer links there instead of duplicating it.
 */
const t = useTranslator()
const drawer = useConsoleDrawer()

/** The newest slice of the feed; the full route keeps the rest. */
const DRAWER_ENTRY_LIMIT = 200
const entries = computed(() => harnessConsole.value.slice(-DRAWER_ENTRY_LIMIT))

const entryList = ref<HTMLElement>()
watch(
  () => harnessConsole.value.length,
  async () => {
    if (!drawer.open.value) return
    await nextTick()
    const list = entryList.value
    if (list !== undefined) list.scrollTop = list.scrollHeight
  }
)

/** Escape collapses the drawer without stealing other key handling. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  drawer.closeConsoleDrawer()
}

const emit = defineEmits<{ navigate: ['controller'] }>()

/** Opening the full console replaces the tail; both should not stay open. */
function openConsole(): void {
  drawer.closeConsoleDrawer()
  emit('navigate', 'controller')
}
</script>

<template>
  <section
    v-if="drawer.open.value"
    class="console-drawer"
    role="log"
    aria-live="polite"
    :aria-label="t('consoleDrawer.title')"
    @keydown="onKeydown"
  >
    <header class="console-drawer-heading">
      <p class="console-drawer-title">{{ t('consoleDrawer.title') }}</p>
      <div class="console-drawer-actions">
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          @click="openConsole"
        >
          {{ t('consoleDrawer.openConsole') }}
        </button>
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          :aria-label="t('consoleDrawer.close')"
          :title="t('consoleDrawer.close')"
          @click="drawer.closeConsoleDrawer()"
        >
          {{ t('consoleDrawer.close') }}
        </button>
      </div>
    </header>
    <ol ref="entryList" class="console-drawer-entries">
      <li
        v-for="(entry, index) in entries"
        :key="`${entry.occurredAt}-${entry.seq}-${index}`"
        :data-stream="entry.stream"
      >
        <time :datetime="new Date(entry.occurredAt).toISOString()">
          {{ new Date(entry.occurredAt).toLocaleTimeString() }}
        </time>
        <span>
          {{
            entry.stream === 'launcher'
              ? t('controller.output.launcher')
              : entry.stream === 'command'
                ? t('controller.output.command')
                : entry.stream === 'stdout'
                  ? t('controller.output.stdout')
                  : t('controller.output.stderr')
          }}
        </span>
        <pre>{{ entry.text }}</pre>
      </li>
    </ol>
  </section>
</template>
