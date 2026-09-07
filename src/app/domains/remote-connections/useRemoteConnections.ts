import { onMounted, ref } from 'vue'
import type {
  ApiResult,
  CreateRemoteConnectionRequest,
  RemoteConnectionErrorCode,
  UpdateRemoteConnectionRequest,
  RemoteConnectionsState
} from '@/shared/contracts'

export const remoteConnectionsState = ref<RemoteConnectionsState>({ connections: [] })
const loading = ref(false)
const pendingActions = ref<
  Readonly<Record<string, 'test' | 'connect' | 'disconnect' | 'remove' | 'update'>>
>({})
const error = ref<RemoteConnectionErrorCode | 'bridge' | 'unconfirmed'>()
let startPromise: Promise<void> | undefined
let unsubscribe: (() => void) | undefined
let revision = 0

function publish(result: ApiResult<RemoteConnectionsState, RemoteConnectionErrorCode>): boolean {
  revision += 1
  if (!result.ok) {
    error.value = result.code
    return false
  }
  remoteConnectionsState.value = result.data
  error.value = undefined
  return true
}

export function startRemoteConnections(): Promise<void> {
  if (startPromise !== undefined) return startPromise
  startPromise = (async () => {
    const api = window.dshLauncher?.remoteConnections
    if (api === undefined) {
      error.value = 'bridge'
      return
    }
    unsubscribe = api.onStateChange(publish)
    const before = revision
    loading.value = true
    try {
      const result = await api.getState()
      if (revision === before) publish(result)
    } catch {
      error.value = 'bridge'
    } finally {
      loading.value = false
    }
  })()
  return startPromise
}

async function create(request: CreateRemoteConnectionRequest): Promise<boolean> {
  const api = window.dshLauncher?.remoteConnections
  if (api === undefined || loading.value) {
    if (api === undefined) error.value = 'bridge'
    return false
  }
  loading.value = true
  try {
    return publish(await api.create(request))
  } catch {
    error.value = 'bridge'
    return false
  } finally {
    loading.value = false
  }
}

async function runIdentityOperation(
  connectionId: string,
  operation: 'test' | 'connect' | 'disconnect' | 'remove'
): Promise<boolean> {
  const api = window.dshLauncher?.remoteConnections
  if (
    api === undefined ||
    (pendingActions.value[connectionId] !== undefined && operation !== 'disconnect')
  ) {
    if (api === undefined) error.value = 'bridge'
    return false
  }
  pendingActions.value = { ...pendingActions.value, [connectionId]: operation }
  error.value = undefined
  try {
    return publish(await api[operation]({ connectionId }))
  } catch {
    error.value = 'bridge'
    return false
  } finally {
    const next = { ...pendingActions.value }
    if (next[connectionId] === operation) delete next[connectionId]
    pendingActions.value = next
  }
}

async function update(request: UpdateRemoteConnectionRequest): Promise<boolean> {
  const api = window.dshLauncher?.remoteConnections
  const id = request.connectionId
  if (api === undefined || pendingActions.value[id] !== undefined) {
    error.value = api === undefined ? 'bridge' : 'remote.connection_busy'
    return false
  }
  pendingActions.value = { ...pendingActions.value, [id]: 'update' }
  error.value = undefined
  try {
    return publish(await api.update(request))
  } catch {
    error.value = 'unconfirmed'
    try {
      const result = await api.getState()
      if (!result.ok) return false
      publish(result)
      const saved = result.data.connections.find((entry) => entry.connectionId === id)
      const confirmed =
        saved !== undefined &&
        saved.displayName === request.displayName &&
        saved.host === request.host &&
        saved.port === request.port &&
        saved.user === request.user
      if (!confirmed) error.value = 'unconfirmed'
      return confirmed
    } catch {
      return false
    }
  } finally {
    const next = { ...pendingActions.value }
    delete next[id]
    pendingActions.value = next
  }
}

async function refresh(): Promise<boolean> {
  const api = window.dshLauncher?.remoteConnections
  if (api === undefined) {
    error.value = 'bridge'
    return false
  }
  try {
    return publish(await api.getState())
  } catch {
    error.value = 'bridge'
    return false
  }
}

export function useRemoteConnections() {
  onMounted(() => void startRemoteConnections())
  return {
    state: remoteConnectionsState,
    loading,
    pendingActions,
    error,
    create,
    update,
    refresh,
    test: (connectionId: string) => runIdentityOperation(connectionId, 'test'),
    connect: (connectionId: string) => runIdentityOperation(connectionId, 'connect'),
    disconnect: (connectionId: string) => runIdentityOperation(connectionId, 'disconnect'),
    remove: (connectionId: string) => runIdentityOperation(connectionId, 'remove')
  }
}

export function resetRemoteConnectionsForTests(): void {
  unsubscribe?.()
  unsubscribe = undefined
  startPromise = undefined
  revision = 0
  remoteConnectionsState.value = { connections: [] }
  loading.value = false
  pendingActions.value = {}
  error.value = undefined
}
