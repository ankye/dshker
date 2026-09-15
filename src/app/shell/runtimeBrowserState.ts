import { computed, reactive, ref, watch } from 'vue'
import { harnessState } from '@/app/domains/launcher-harness/useLauncherHarness'
import {
  p2pConnections,
  p2pManagement,
  remoteConnectionsState
} from '@/app/domains/remote-connections'
import type { RemoteConnectionStatus } from '@/shared/contracts'

export type RuntimeTabId = 'local' | `remote:${string}` | `peer:${string}`
export type RuntimeRemoteTabId = Exclude<RuntimeTabId, 'local'>

/**
 * Connection state a tab can report, with no address in it.
 *
 * A peer tab is reported as a stage, never as an address: the address arrives
 * separately, from the one operation that hands it over for a named attempt, so a
 * tab's status can never be mistaken for permission to open a gateway.
 * `RemoteConnectionStatus` carries a `url` on `ready`, so peer state is projected
 * to this address-free shape instead of reusing it. `failed` keeps only a code,
 * never helper-supplied text.
 */
export type RuntimeTabStatus =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly code: string }

/** One local workspace plus a lazily opened SSH or paired-computer workspace. */
export interface RuntimeTab {
  readonly id: RuntimeTabId
  readonly source: 'local' | 'remote' | 'peer'
  readonly connectionId?: string
  url: string | undefined
  /**
   * The guest partition a peer tab must mount in, named by main.
   *
   * Absent for the local tab and for SSH remotes, which use the default session.
   */
  readonly partition?: string
  title: string
  readonly status: RuntimeTabStatus | undefined
}

/** Drops the SSH address so both sources report the same address-free shape. */
function withoutAddress(status: RemoteConnectionStatus): RuntimeTabStatus {
  switch (status.kind) {
    case 'ready':
      return { kind: 'ready' }
    case 'failed':
      return { kind: 'failed', code: status.code }
    default:
      return { kind: status.kind }
  }
}

/**
 * Projects a pair connection onto the tab's state.
 *
 * A revoked pair is reported disconnected rather than failed: losing
 * authorization is not a connection fault. An unread connection list yields
 * undefined, which stays distinct from a confirmed disconnected state.
 */
function peerTabStatus(
  serviceId: string,
  pairId: string,
  pairState: 'active' | 'revoked'
): RuntimeTabStatus | undefined {
  if (pairState === 'revoked') return { kind: 'disconnected' }
  if (p2pConnections.state.peers === undefined) return undefined
  const peer = p2pConnections.find(serviceId, pairId)
  if (peer === undefined) return { kind: 'disconnected' }
  switch (peer.stage) {
    case 'punching':
    case 'starting-runtime':
      return { kind: 'connecting' }
    case 'ready':
      return { kind: 'ready' }
    case 'failed':
      return { kind: 'failed', code: peer.error }
    default:
      return { kind: 'disconnected' }
  }
}

const navigation = reactive<Record<string, { url: string; title: string } | undefined>>({})
const remoteSourceUrls = new Map<string, string>()
const remoteDisplayNames = new Map<string, string>()
/** Remote workspaces are deliberately lazy: a large fleet must not mount 20 guests at startup. */
const openedRemoteTabIds = reactive(new Set<RuntimeRemoteTabId>())
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
    ...remoteConnectionsState.value.connections
      .map((connection): RuntimeTab => {
        const id = `remote:${connection.connectionId}` as const
        const current = navigation[id]
        const readyUrl = connection.status.kind === 'ready' ? connection.status.url : undefined
        return {
          id,
          source: 'remote',
          connectionId: connection.connectionId,
          url: readyUrl === undefined ? undefined : (current?.url ?? readyUrl),
          title: current?.title ?? connection.displayName,
          status: withoutAddress(connection.status)
        }
      })
      .filter((tab) => isOpenedRemoteTab(tab)),
    ...peerTabs().filter((tab) => isOpenedRemoteTab(tab))
  ]
})

function isOpenedRemoteTab(tab: RuntimeTab): boolean {
  return tab.id !== 'local' && openedRemoteTabIds.has(tab.id)
}

/**
 * Tabs for paired computers.
 *
 * A revoked pair keeps its tab so the user can see why it stopped working, but
 * it can never carry a URL. A ready peer's address is fetched per attempt and
 * keyed by generation; it is a loopback gateway for one guest, isolated by the
 * partition main names for the pair.
 */
function peerTabs(): RuntimeTab[] {
  const computers = p2pManagement.catalog.value?.computers ?? []
  return computers.map((computer): RuntimeTab => {
    const id = `peer:${computer.connectionId}` as const
    const status = peerTabStatus(computer.serviceId, computer.pairId, computer.pairState)
    const current = navigation[id]
    return {
      id,
      source: 'peer',
      connectionId: computer.connectionId,
      // The address main handed over for this attempt is what lets the guest mount
      // at all: the catalog never carries it, and without it a ready peer rendered
      // the empty state forever.
      url: status?.kind === 'ready' ? (current?.url ?? peerEntries[id]?.url) : undefined,
      // The guest for a peer is isolated by main's own partition for this pair.
      partition: status?.kind === 'ready' ? peerEntries[id]?.partition : undefined,
      title: current?.title ?? computer.displayName,
      status
    }
  })
}

/**
 * Workbench addresses main has handed over for connected peers.
 *
 * Each address is a loopback gateway with a token, valid for one attempt: main
 * answers only for the attempt it is asked about, so an entry is keyed by
 * generation and dropped the moment the peer or the attempt changes. It reaches
 * the renderer because only a real http URL can be mounted; what keeps one peer's
 * session away from another is the guest partition, not the address.
 */
const peerEntries = reactive<
  Record<string, { generation: number; url: string; partition: string }>
>({})

/** The fetch in flight per tab, so one attempt is asked about once. */
const peerEntryFetches = new Map<string, Promise<void>>()

/**
 * Asks main for the address of every ready peer.
 *
 * A peer becomes `ready` before its address has been asked for, so one fetch per
 * attempt is what closes the loop: the stage says the workbench is up, and this
 * turns that into the URL the tab mounts. A missing address is not an error — the
 * tab keeps its empty state, and the next stage change tries again.
 *
 * Two rules keep a stale answer out of a live tab: the fetch is remembered, so a
 * second stage change while one is in flight does not stack requests, and the
 * generation is re-read after the await, so an answer that belongs to an attempt
 * the peer has already replaced is dropped instead of overwriting the newer one.
 */
async function loadPeerEntries(): Promise<void> {
  for (const computer of p2pManagement.catalog.value?.computers ?? []) {
    const id = `peer:${computer.connectionId}`
    const view = p2pConnections.find(computer.serviceId, computer.pairId)
    if (computer.pairState !== 'active' || view?.stage !== 'ready') {
      delete peerEntries[id]
      continue
    }
    // Already holding the address of the attempt the tab is showing.
    if (peerEntries[id]?.generation === view.generation) continue
    // One question per attempt: a second stage change while main is answering
    // must not open a second request, or answers could arrive out of order.
    if (peerEntryFetches.has(id)) continue
    const { serviceId, pairId } = computer
    const generation = view.generation
    const fetch = p2pConnections.entry(serviceId, pairId, generation).then((entry) => {
      peerEntryFetches.delete(id)
      // The attempt this answer describes may have been replaced while we
      // waited. Storing it would put the previous attempt's address in a tab
      // that is already showing the next one, so drop it — and ask about the
      // attempt that is actually current, since the change that replaced it
      // found this fetch in flight and left it alone.
      if (p2pConnections.find(serviceId, pairId)?.generation !== generation) {
        void loadPeerEntries()
        return
      }
      if (entry === undefined) delete peerEntries[id]
      else peerEntries[id] = { generation, ...entry }
    })
    peerEntryFetches.set(id, fetch)
    await fetch
  }
}

// Both inputs matter: the stage decides whether a peer is ready, and the catalog
// decides whether the tab exists at all. Watching only the stage meant a computer
// that appeared already ready never had its address asked for.
watch(
  [() => p2pConnections.state.peers, () => p2pManagement.catalog.value?.computers],
  () => {
    void loadPeerEntries()
  },
  { deep: true }
)

/** Creates and focuses exactly one remote workspace after an explicit user action. */
function openRemoteTab(id: RuntimeRemoteTabId): boolean {
  const exists = id.startsWith('remote:')
    ? remoteConnectionsState.value.connections.some(
        (connection) => `remote:${connection.connectionId}` === id
      )
    : p2pManagement.catalog.value?.computers.some(
        (computer) => `peer:${computer.connectionId}` === id
      ) === true
  if (!exists) return false
  openedRemoteTabIds.add(id)
  activeTabId.value = id
  return true
}

/** Test-only reset; production has no close-tab operation for managed workspaces. */
export function resetRuntimeBrowserForTests(): void {
  openedRemoteTabIds.clear()
  activeTabId.value = 'local'
}

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

/** Records navigation for one open workspace while its authoritative source stays ready. */
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
    const available = new Set<string>()
    const retained = new Set<string>(['local'])
    for (const connection of connections) {
      const id = `remote:${connection.connectionId}`
      available.add(id)
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
    for (const id of [...openedRemoteTabIds])
      if (id.startsWith('remote:') && !available.has(id)) openedRemoteTabIds.delete(id)
    if (!tabs.value.some((tab) => tab.id === activeTabId.value)) activeTabId.value = 'local'
  },
  { deep: true }
)

watch(
  () => ({
    computers: p2pManagement.catalog.value?.computers,
    peers: p2pConnections.state.peers
  }),
  ({ computers }) => {
    const available = new Set<string>()
    const retained = new Set<string>()
    for (const computer of computers ?? []) {
      const id = `peer:${computer.connectionId}`
      available.add(id)
      const usable =
        computer.pairState === 'active' &&
        p2pConnections.isReady(computer.serviceId, computer.pairId)
      // A revoked or disconnected peer must not keep a loadable address.
      if (!usable) delete navigation[id]
      else retained.add(id)
    }
    for (const id of [...openedRemoteTabIds])
      if (id.startsWith('peer:') && !available.has(id)) openedRemoteTabIds.delete(id)
    for (const id of Object.keys(navigation)) {
      if (id.startsWith('peer:') && !retained.has(id)) delete navigation[id]
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
  updateTab,
  openRemoteTab
}
