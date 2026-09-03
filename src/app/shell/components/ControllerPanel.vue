<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { useTranslator } from '@/app/shared/i18n/useLocale'
import { CopyPathButton } from '@/app/shared/controls'
import EmptyState from './EmptyState.vue'

const t = useTranslator()
const harness = useLauncherHarness()

const emit = defineEmits<{ navigate: ['launch'] }>()

const CONFIRMATION_MILLISECONDS = 1_600

const logFile = computed(() => harness.state.value?.logFile)
const consoleEntries = computed(() =>
  harness.state.value?.kind === 'ready' ? harness.state.value.console : []
)
const copiedOutput = ref(false)
const copiedLine = ref(false)
const exported = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined
let copyLineTimer: ReturnType<typeof setTimeout> | undefined
let exportTimer: ReturnType<typeof setTimeout> | undefined
const copyMenu = ref<Readonly<{ text: string; x: number; y: number }>>()

/**
 * Copies the visible output as plain text.
 *
 * Selecting hundreds of `<pre>` rows by hand is the failure mode this replaces,
 * and the timestamps and stream markers are preserved so a pasted excerpt still
 * says when each line arrived and whether it was stderr.
 */
async function copyOutput(): Promise<void> {
  const text = consoleEntries.value
    .map(
      (entry) =>
        `[${new Date(entry.occurredAt).toISOString()}] ${entry.stream}: ${entry.text.replace(/\n$/u, '')}`
    )
    .join('\n')
  if (text.length === 0) return
  try {
    await navigator.clipboard.writeText(text)
    copiedOutput.value = true
    if (copyTimer !== undefined) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedOutput.value = false
    }, CONFIRMATION_MILLISECONDS)
  } catch {
    // A denied clipboard is not worth interrupting a diagnosis for; the output
    // stays selectable, and the log file remains the durable copy.
  }
}

/** Opens an explicit log-only copy action without exposing a global web context menu. */
function openCopyMenu(event: MouseEvent): void {
  const output = event.currentTarget
  if (!(output instanceof HTMLElement)) return
  const selection = window.getSelection()
  const selected =
    selection !== null &&
    selection.anchorNode !== null &&
    selection.focusNode !== null &&
    output.contains(selection.anchorNode) &&
    output.contains(selection.focusNode)
      ? selection.toString().trim()
      : ''
  const row = event.target instanceof HTMLElement ? event.target.closest('li') : null
  const text = selected.length > 0 ? selected : (row?.textContent?.trim() ?? '')
  if (text.length === 0) return
  event.preventDefault()
  copyMenu.value = { text, x: event.clientX, y: event.clientY }
}

/** Copies the selected log text, or the row that opened the contextual action. */
async function copyContextText(): Promise<void> {
  const text = copyMenu.value?.text
  copyMenu.value = undefined
  if (text === undefined) return
  try {
    await navigator.clipboard.writeText(text)
    copiedLine.value = true
    if (copyLineTimer !== undefined) clearTimeout(copyLineTimer)
    copyLineTimer = setTimeout(() => {
      copiedLine.value = false
    }, CONFIRMATION_MILLISECONDS)
  } catch {
    // Clipboard permission can be denied by the host; the log remains selectable.
  }
}

/** Removes the contextual action when it loses focus. */
function dismissCopyMenu(): void {
  copyMenu.value = undefined
}

/** Lets Escape cancel the contextual action without changing other key behavior. */
function dismissCopyMenuOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  dismissCopyMenu()
}

async function exportLog(): Promise<void> {
  const saved = await harness.exportLog()
  if (!saved) return
  exported.value = true
  if (exportTimer !== undefined) clearTimeout(exportTimer)
  exportTimer = setTimeout(() => {
    exported.value = false
  }, CONFIRMATION_MILLISECONDS)
}

onMounted(() => {
  window.addEventListener('click', dismissCopyMenu)
  window.addEventListener('keydown', dismissCopyMenuOnEscape)
})

onUnmounted(() => {
  if (copyTimer !== undefined) clearTimeout(copyTimer)
  if (copyLineTimer !== undefined) clearTimeout(copyLineTimer)
  if (exportTimer !== undefined) clearTimeout(exportTimer)
  window.removeEventListener('click', dismissCopyMenu)
  window.removeEventListener('keydown', dismissCopyMenuOnEscape)
})
</script>

<template>
  <section class="controller-panel" :aria-busy="harness.loading.value">
    <!--
      The log path is the thing a user pastes into a bug report, so it is shown
      as selectable text with copy beside it rather than hidden behind a menu.
    -->
    <div v-if="logFile" class="controller-log-bar">
      <span class="controller-log-label">{{ t('controller.log.label') }}</span>
      <code class="controller-log-path" :title="logFile.path">{{ logFile.path }}</code>
      <CopyPathButton :value="logFile.path" />
      <span v-if="!logFile.exists" class="controller-log-hint">
        {{ t('controller.log.pending') }}
      </span>
      <div class="controller-log-actions">
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          :disabled="!logFile.exists"
          @click="harness.revealLog"
        >
          {{ t('controller.log.reveal') }}
        </button>
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          :data-confirmed="exported"
          :disabled="!logFile.exists"
          @click="exportLog"
        >
          {{ exported ? t('controller.log.exported') : t('controller.log.export') }}
        </button>
        <button
          type="button"
          class="prototype-button prototype-button--secondary"
          :data-confirmed="copiedOutput"
          :disabled="consoleEntries.length === 0"
          @click="copyOutput"
        >
          {{ copiedOutput ? t('common.copied') : t('controller.log.copyOutput') }}
        </button>
      </div>
    </div>

    <!--
      Two distinct conditions that previously shared one message: the shell is
      not ready yet, versus it is ready and simply has produced no output.
    -->
    <EmptyState
      v-if="harness.state.value?.kind !== 'ready'"
      icon="plug"
      fill
      :title="t('controller.notReady')"
      :description="t('controller.notReady.description')"
    />
    <EmptyState
      v-else-if="harness.state.value.console.length === 0"
      icon="inbox"
      fill
      :title="t('controller.empty')"
      :description="t('controller.empty.description')"
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
    <ol v-else class="controller-output" aria-live="polite" @contextmenu="openCopyMenu">
      <li
        v-for="(entry, index) in harness.state.value.console"
        :key="`${entry.occurredAt}-${index}`"
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

    <button
      v-if="copyMenu"
      class="controller-copy-menu prototype-button prototype-button--secondary"
      type="button"
      :style="{ left: `${copyMenu.x}px`, top: `${copyMenu.y}px` }"
      @click="copyContextText"
    >
      {{ copiedLine ? t('common.copied') : t('controller.log.copyContext') }}
    </button>
  </section>
</template>
