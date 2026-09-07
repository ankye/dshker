import { computed, reactive, ref, watch } from 'vue'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import { remoteConnectionsState } from '@/app/domains/remote-connections'
import type { RemoteConnectionStatus } from '@/shared/contracts'

export type RuntimeTabId = 'local' | `remote:${string}`

/** One fixed local or registered-computer browser workspace. */
export interface RuntimeTab {
  readonly id: RuntimeTabId
  readonly source: 'local' | 'remote'
  readonly connectionId?: string
  url: string | undefined
  title: string
  readonly status: RemoteConnectionStatus | undefined
}

const navigation = reactive<Record<string, { url: string; title: string } | undefined>>({})
const remoteSourceUrls = new Map<string, string>()
const remoteDisplayNames = new Map<string, string>()
const activeTabId = ref<RuntimeTabId>('local')

/** Exact address announced by the locally supervised DSH child. */
const runtimeUrl = computed(() => {
  const launch = harnessState.value?.launch
  return launch?.kind === 'running' ? launch.url : undefined
})

const tabs = computed<readonly RuntimeTab[]>(() => {
  const localNavigation = navigation.local
  const local: RuntimeTab = {
    id: 'local',
    source: 'local',
    url: runtimeUrl.value === undefined ? undefined : (localNavigation?.url ?? runtimeUrl.value),
    title: localNavigation?.title ?? '',
    status: undefined
  }
  return [
    local,
    ...remoteConnectionsState.value.connections.map((connection): RuntimeTab => {
      const id = `remote:${connection.connectionId}` as const
      const current = navigation[id]
      const readyUrl = connection.status.kind === 'ready' ? connection.status.url : undefined
      return {
        id,
        source: 'remote',
        connectionId: connection.connectionId,
        url: readyUrl === undefined ? undefined : (current?.url ?? readyUrl),
        title: current?.title ?? connection.displayName,
        status: connection.status
      }
    })
  ]
})

const activeTab = computed(
  () => tabs.value.find((tab) => tab.id === activeTabId.value) ?? tabs.value[0]
)

/** Admits only a loopback http(s) address; the main process constrains remote mappings too. */
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

/** Records navigation for one fixed workspace while its authoritative source stays ready. */
function updateTab(id: RuntimeTabId, changes: Partial<Pick<RuntimeTab, 'url' | 'title'>>): void {
  if (!tabs.value.some((tab) => tab.id === id)) return
  const current = navigation[id] ?? { url: '', title: '' }
  navigation[id] = {
    url: changes.url ?? current.url,
    title: changes.title ?? current.title
  }
}

watch(runtimeUrl, (url, previous) => {
  if (url === undefined) {
    delete navigation.local
    return
  }
  if (url !== previous) navigation.local = { url, title: '' }
})

watch(
  () => remoteConnectionsState.value.connections,
  (connections) => {
    const retained = new Set<string>(['local'])
    for (const connection of connections) {
      const id = `remote:${connection.connectionId}`
      retained.add(id)
      const renamed =
        remoteDisplayNames.has(id) && remoteDisplayNames.get(id) !== connection.displayName
      remoteDisplayNames.set(id, connection.displayName)
      if (connection.status.kind !== 'ready') {
        delete navigation[id]
        remoteSourceUrls.delete(id)
      } else if (remoteSourceUrls.get(id) !== connection.status.url) {
        remoteSourceUrls.set(id, connection.status.url)
        navigation[id] = { url: connection.status.url, title: connection.displayName }
      } else if (renamed && navigation[id] !== undefined) {
        navigation[id] = { url: navigation[id].url, title: connection.displayName }
      }
    }
    for (const id of Object.keys(navigation)) {
      if (!retained.has(id)) {
        delete navigation[id]
        remoteSourceUrls.delete(id)
        remoteDisplayNames.delete(id)
      }
    }
    if (!tabs.value.some((tab) => tab.id === activeTabId.value)) activeTabId.value = 'local'
  },
  { deep: true }
)

/** Shared fixed-workspace Run state, preserved across route changes. */
export const runtimeBrowser = {
  tabs,
  activeTabId,
  activeTab,
  runtimeUrl,
  updateTab
}
