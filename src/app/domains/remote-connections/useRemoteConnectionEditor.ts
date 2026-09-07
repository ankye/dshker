import { computed, ref } from 'vue'
import type { RemoteConnectionView } from '@/shared/contracts'
import { remoteConnectionsState } from './useRemoteConnections'

interface RemoteDraft {
  displayName: string
  host: string
  port: string
  user: string
}

const original = ref<RemoteConnectionView>()
const draft = ref<RemoteDraft>()
const discardRequested = ref(false)
const nextTarget = ref<string>()
const dirty = computed(() => {
  const saved = original.value
  const current = draft.value
  return (
    saved !== undefined &&
    current !== undefined &&
    (saved.displayName !== current.displayName ||
      saved.host !== current.host ||
      String(saved.port) !== current.port ||
      saved.user !== current.user)
  )
})

function open(connectionId: string): boolean {
  if (dirty.value && original.value?.connectionId !== connectionId) {
    nextTarget.value = connectionId
    discardRequested.value = true
    return false
  }
  const current = remoteConnectionsState.value.connections.find(
    (entry) => entry.connectionId === connectionId
  )
  if (current === undefined) return false
  if (original.value?.connectionId === connectionId) return true
  original.value = { ...current }
  draft.value = {
    displayName: current.displayName,
    host: current.host,
    port: String(current.port),
    user: current.user
  }
  return true
}

function close(): boolean {
  if (dirty.value) {
    nextTarget.value = undefined
    discardRequested.value = true
    return false
  }
  clear()
  return true
}

function clear(): void {
  original.value = undefined
  draft.value = undefined
  discardRequested.value = false
}

function discard(): void {
  const target = nextTarget.value
  nextTarget.value = undefined
  clear()
  if (target !== undefined) open(target)
}

export const remoteConnectionEditor = {
  original,
  draft,
  dirty,
  discardRequested,
  open,
  close,
  clear,
  discard,
  keep: () => {
    discardRequested.value = false
    nextTarget.value = undefined
  },
  reload: () => {
    const id = original.value?.connectionId
    clear()
    if (id !== undefined) open(id)
  }
}
