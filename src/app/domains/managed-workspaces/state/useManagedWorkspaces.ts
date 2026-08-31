import { computed, onMounted, ref } from 'vue'
import type {
  DesktopApi,
  DesktopApiErrorCode,
  DirectorySelectionPurpose,
  ManagedDirectorySelection,
  ManagedRootKind
} from '@/shared/contracts'
import {
  MANAGED_ROOT_SETUP_ITEMS,
  type ManagedWorkspacesFeedback,
  type ManagedWorkspacesOperation,
  type ManagedWorkspacesViewState,
  type RootSelectionView
} from '../contracts'

/** The only managed IPC capabilities needed by this renderer domain. */
export type ManagedWorkspacesApi = DesktopApi['managed']

/** Projects selected directory authority without receiving a filesystem path. */
function toRootSelection(
  kind: ManagedRootKind,
  selection: ManagedDirectorySelection
): RootSelectionView {
  return { kind, selection }
}

/** Owns explicit directory registration and workspace creation through the preload bridge. */
export function useManagedWorkspaces(
  api: ManagedWorkspacesApi | undefined = window.dshLauncher?.managed
) {
  const state = ref<ManagedWorkspacesViewState>({ kind: 'loading' })
  const feedback = ref<ManagedWorkspacesFeedback>({ kind: 'none' })
  const activeOperation = ref<ManagedWorkspacesOperation>()
  const rootSelections = ref<readonly RootSelectionView[]>([])
  const workingDirectorySelection = ref<ManagedDirectorySelection>()
  const workspaceDisplayName = ref('')

  const isBusy = computed(() => activeOperation.value !== undefined)
  const canRegisterRoots = computed(
    () =>
      state.value.kind === 'setup-required' &&
      rootSelections.value.length === MANAGED_ROOT_SETUP_ITEMS.length &&
      !isBusy.value
  )
  const canCreateWorkspace = computed(
    () =>
      state.value.kind === 'ready' &&
      workingDirectorySelection.value !== undefined &&
      workspaceDisplayName.value.trim().length > 0 &&
      !isBusy.value
  )
  const orderedRoots = computed(() => {
    const readyState = state.value
    if (readyState.kind !== 'ready') return []
    return MANAGED_ROOT_SETUP_ITEMS.flatMap((item) => {
      const root = readyState.roots.find((entry) => entry.kind === item.kind)
      return root ? [{ ...root, setupItem: item }] : []
    })
  })
  const workspaces = computed(() => (state.value.kind === 'ready' ? state.value.workspaces : []))

  /** Reads main-process registry health without inventing a local persistence state. */
  async function initialize(): Promise<void> {
    await run({ kind: 'load' }, async () => {
      if (!api) {
        state.value = { kind: 'bridge-unavailable' }
        feedback.value = { kind: 'none' }
        return
      }
      const result = await api.getState()
      if (!result.ok) {
        state.value = { kind: 'error', code: result.code }
        feedback.value = { kind: 'error', code: result.code }
        return
      }
      state.value = result.data
      feedback.value = { kind: 'none' }
    })
  }

  /** Requests a native directory only for the named root role. */
  async function selectRootDirectory(kind: ManagedRootKind): Promise<void> {
    const item = MANAGED_ROOT_SETUP_ITEMS.find((entry) => entry.kind === kind)
    if (!item || !api || state.value.kind !== 'setup-required') return
    await run({ kind: 'select-root', rootKind: kind }, async () => {
      const result = await api.selectDirectory(item.purpose)
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      if (result.data.purpose !== item.purpose) {
        recordOperationFailure('managed.selection_invalid')
        return
      }
      rootSelections.value = [
        ...rootSelections.value.filter((entry) => entry.kind !== kind),
        toRootSelection(kind, result.data)
      ]
      feedback.value = { kind: 'none' }
    })
  }

  /** Submits the exact four selected root capabilities in the fixed ownership order. */
  async function registerRoots(): Promise<void> {
    if (!api || !canRegisterRoots.value) return
    const selections = rootSelectionsForRegistration(rootSelections.value)
    if (!selections) return
    await run({ kind: 'register-roots' }, async () => {
      const result = await api.registerRoots({ selections })
      if (!result.ok) {
        // Main may already have consumed a native capability before reporting a persistence failure.
        // Forgetting them is safer than representing a capability as reusable.
        rootSelections.value = []
        recordOperationFailure(result.code)
        return
      }
      rootSelections.value = []
      state.value = result.data
      feedback.value =
        result.data.kind === 'ready' ? { kind: 'roots-registered' } : { kind: 'none' }
    })
  }

  /** Requests a one-use native selection for the next workspace's working directory. */
  async function selectWorkingDirectory(): Promise<void> {
    if (!api || state.value.kind !== 'ready') return
    const purpose: DirectorySelectionPurpose = 'workspace-working-directory'
    await run({ kind: 'select-working-directory' }, async () => {
      const result = await api.selectDirectory(purpose)
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      if (result.data.purpose !== purpose) {
        recordOperationFailure('managed.selection_invalid')
        return
      }
      workingDirectorySelection.value = result.data
      feedback.value = { kind: 'none' }
    })
  }

  /** Creates a workspace only from a separately selected working-directory capability. */
  async function createWorkspace(): Promise<void> {
    const selectedDirectory = workingDirectorySelection.value
    if (!api || !selectedDirectory || !canCreateWorkspace.value) return
    await run({ kind: 'create-workspace' }, async () => {
      const result = await api.createWorkspace({
        displayName: workspaceDisplayName.value,
        workingDirectoryCapabilityId: selectedDirectory.capabilityId
      })
      if (!result.ok) {
        // The service may consume before persistence, so the renderer requires a new explicit selection.
        workingDirectorySelection.value = undefined
        recordOperationFailure(result.code)
        return
      }
      workingDirectorySelection.value = undefined
      workspaceDisplayName.value = ''
      state.value = result.data
      feedback.value =
        result.data.kind === 'ready' ? { kind: 'workspace-created' } : { kind: 'none' }
    })
  }

  function rootSelectionFor(kind: ManagedRootKind): ManagedDirectorySelection | undefined {
    return rootSelections.value.find((entry) => entry.kind === kind)?.selection
  }

  function recordOperationFailure(code: DesktopApiErrorCode): void {
    feedback.value =
      code === 'managed.selection_cancelled' ? { kind: 'cancelled', code } : { kind: 'error', code }
  }

  async function run(
    operation: ManagedWorkspacesOperation,
    action: () => Promise<void>
  ): Promise<void> {
    if (activeOperation.value !== undefined) return
    activeOperation.value = operation
    try {
      await action()
    } finally {
      activeOperation.value = undefined
    }
  }

  onMounted(() => {
    void initialize()
  })

  return {
    activeOperation,
    canCreateWorkspace,
    canRegisterRoots,
    createWorkspace,
    feedback,
    initialize,
    isBusy,
    orderedRoots,
    registerRoots,
    rootSelectionFor,
    selectRootDirectory,
    selectWorkingDirectory,
    state,
    workspaceDisplayName,
    workingDirectorySelection,
    workspaces
  }
}

function rootSelectionsForRegistration(selections: readonly RootSelectionView[]):
  | readonly {
      readonly kind: ManagedRootKind
      readonly capabilityId: string
    }[]
  | undefined {
  const registered = [] as { kind: ManagedRootKind; capabilityId: string }[]
  for (const item of MANAGED_ROOT_SETUP_ITEMS) {
    const selection = selections.find((entry) => entry.kind === item.kind)
    if (!selection) return undefined
    registered.push({ kind: item.kind, capabilityId: selection.selection.capabilityId })
  }
  return registered
}
