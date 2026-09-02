<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
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
const launch = computed(() =>
  harness.state.value?.kind === 'ready' ? harness.state.value.launch : undefined
)
const launchStatus = computed(() => {
  switch (launch.value?.kind) {
    case 'running':
      return t('controller.status.running')
    case 'starting':
      return t('controller.status.starting')
    case 'failed':
      return t('controller.status.failed')
    case 'stopped':
    case undefined:
      return t('controller.status.stopped')
  }
})
const launchAction = computed(() =>
  launch.value?.kind === 'running'
    ? t('controller.stop')
    : launch.value?.kind === 'starting'
      ? t('controller.status.starting')
      : t('controller.oneClickStart')
)
const launchActionDisabled = computed(
  () => harness.loading.value || launch.value?.kind === 'starting'
)

const copiedOutput = ref(false)
const exported = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined
let exportTimer: ReturnType<typeof setTimeout> | undefined

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

async function exportLog(): Promise<void> {
  const saved = await harness.exportLog()
  if (!saved) return
  exported.value = true
  if (exportTimer !== undefined) clearTimeout(exportTimer)
  exportTimer = setTimeout(() => {
    exported.value = false
  }, CONFIRMATION_MILLISECONDS)
}

/** Starts the selected DSH version, or stops the exact child this Launcher created. */
async function toggleLaunch(): Promise<void> {
  if (launch.value?.kind === 'running') {
    await harness.stop()
    return
  }
  await harness.start()
}

onUnmounted(() => {
  if (copyTimer !== undefined) clearTimeout(copyTimer)
  if (exportTimer !== undefined) clearTimeout(exportTimer)
})
</script>

<template>
  <section class="controller-panel" :aria-busy="harness.loading.value">
    <div class="controller-command">
      <span>{{ t('controller.command') }}</span>
      <code>pnpm dsh web --patch &lt;launcher-diagnostics&gt; --no-open</code>
      <button
        v-if="
          harness.state.value?.kind === 'ready' && harness.state.value.launch.kind === 'running'
        "
        class="prototype-button prototype-button--secondary"
        type="button"
        :disabled="harness.loading.value"
        @click="harness.stop"
      >
        {{ t('controller.stop') }}
      </button>
    </div>

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
    <ol v-else class="controller-output" aria-live="polite">
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

    <footer v-if="launch" class="controller-bottom-action">
      <span class="controller-runtime-status" :data-state="launch.kind">
        {{ launchStatus }}
      </span>
      <button
        type="button"
        class="prototype-button prototype-button--primary"
        :disabled="launchActionDisabled"
        @click="toggleLaunch"
      >
        {{ launchAction }}
      </button>
    </footer>
  </section>
</template>
