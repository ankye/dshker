import { computed, ref, watch } from 'vue'
import { harnessConsole } from '@/app/domains/launcher-harness'

/**
 * Shell-level state for the floating console tail.
 *
 * Session-only by design: the drawer is a glance surface for the operation the
 * user just started, not a persisted pane. Unread marks entries that arrived
 * while the drawer was closed, so the sidebar control can advertise new output
 * without ever covering content the user is reading.
 */
const open = ref(false)
let seenEntries = 0

// While open, every arriving entry counts as seen; the badge exists only for
// the closed state.
watch(
  [open, harnessConsole],
  () => {
    if (open.value) seenEntries = harnessConsole.value.length
  },
  { immediate: true }
)

/** True when entries arrived since the drawer was last seen or baselined. */
const unread = computed(() => !open.value && harnessConsole.value.length > seenEntries)

/** Marks the current feed as seen without opening the drawer. */
function markConsoleSeen(): void {
  seenEntries = harnessConsole.value.length
}

function toggleConsoleDrawer(): void {
  open.value = !open.value
}

function closeConsoleDrawer(): void {
  open.value = false
}

/** State and actions for the sidebar control and the drawer surface. */
export function useConsoleDrawer() {
  return {
    open,
    unread,
    markConsoleSeen,
    toggleConsoleDrawer,
    closeConsoleDrawer
  }
}
