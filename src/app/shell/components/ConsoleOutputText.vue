<script setup lang="ts">
import { computed } from 'vue'
import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'
import { consoleOutputParts } from '../consoleOutput'

const props = defineProps<{ entry: LauncherHarnessConsoleEntry }>()
const parts = computed(() => consoleOutputParts(props.entry))
</script>

<template>
  <pre class="console-output-text"><span
    v-for="(part, index) in parts"
    :key="index"
    class="console-output-line"
    :data-severity="part.severity"
  >{{ part.text }}</span></pre>
</template>

<style scoped>
/* Both consoles use a dark log canvas even when the shell uses its light theme.
 * Text severity deliberately does not inherit the legacy row stream colors. */
.console-output-text .console-output-line {
  color: #72d9a0;
  white-space: inherit;
}

.console-output-text .console-output-line[data-severity='error'] {
  color: #ffaba5;
}
</style>
