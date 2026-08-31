<script setup lang="ts">
import { useLauncherHarness } from '@/app/domains/launcher-harness'
import { INITIAL_LOCALE, createTranslator } from '@/app/shared/i18n/i18n'

const t = createTranslator(INITIAL_LOCALE)
const harness = useLauncherHarness()
</script>

<template>
  <section class="controller-panel" :aria-busy="harness.loading.value">
    <div class="controller-command">
      <span>{{ t('controller.command') }}</span>
      <code>pnpm dsh -- web --no-open</code>
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

    <p v-if="harness.state.value?.kind !== 'ready'" class="controller-empty">
      {{ t('controller.empty') }}
    </p>
    <div v-else-if="harness.state.value.console.length === 0" class="controller-empty">
      {{ t('controller.empty') }}
    </div>
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
            entry.stream === 'stdout'
              ? t('controller.output.stdout')
              : t('controller.output.stderr')
          }}
        </span>
        <pre>{{ entry.text }}</pre>
      </li>
    </ol>
  </section>
</template>
