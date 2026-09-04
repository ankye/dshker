import { computed, reactive, ref, watch } from 'vue'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'

/** One run-view browser tab. */
export interface RuntimeTab {
  readonly id: number
  /** Address to load; updated as the guest navigates. */
  url: string
  /** Page title reported by the guest, falling back to its address. */
  title: string
}

// Module-level state: switching to another route unmounts the run panel, and the
// open tabs plus their addresses must survive that so returning restores them.
const tabs = reactive<RuntimeTab[]>([])
const activeTabId = ref<number>()
let nextTabId = 1

/** The address the started DSH process announced, including its credential. */
const runtimeUrl = computed(() => {
  const launch = harnessState.value?.launch
  return launch?.kind === 'running' ? launch.url : undefined
})

const activeTab = computed(() => tabs.find((tab) => tab.id === activeTabId.value))

/** Admits only a loopback http(s) address; the main process checks this again. */
export function isLoopbackAddress(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/** Opens a tab at the announced runtime address and focuses it. */
function openTab(url?: string): void {
  const target = url ?? runtimeUrl.value
  if (target === undefined) return
  const id = nextTabId
  nextTabId += 1
  tabs.push({ id, url: target, title: target })
  activeTabId.value = id
}

/** Closes one tab, focusing a neighbour so the view never goes blank. */
function closeTab(id: number): void {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  tabs.splice(index, 1)
  if (activeTabId.value !== id) return
  activeTabId.value = tabs[Math.min(index, tabs.length - 1)]?.id
}

/** Records what the guest actually navigated to, keeping the strip truthful. */
function updateTab(id: number, changes: Partial<Pick<RuntimeTab, 'url' | 'title'>>): void {
  const tab = tabs.find((entry) => entry.id === id)
  if (tab === undefined) return
  if (changes.url !== undefined) tab.url = changes.url
  if (changes.title !== undefined) tab.title = changes.title
}

/** Drops every tab; used when the runtime it pointed at is gone. */
function resetTabs(): void {
  tabs.splice(0, tabs.length)
  activeTabId.value = undefined
}

// The Run view is where the launched DSH Web gets browsed, so a fresh launch
// opens its first page automatically; the tab survives route changes because
// this state is module-level. Closing every tab does not reopen anything —
// only an actual stop/start transition does.
watch(runtimeUrl, (url) => {
  if (url === undefined) {
    resetTabs()
    return
  }
  if (tabs.length === 0) openTab(url)
})

/** Shared run-view browser state, preserved across route changes. */
export const runtimeBrowser = {
  tabs,
  activeTabId,
  activeTab,
  runtimeUrl,
  openTab,
  closeTab,
  updateTab,
  resetTabs
}
