import { computed, onMounted, ref } from 'vue'
import {
  MANAGED_EXECUTABLE_KINDS,
  type ManagedExecutableKind,
  type ManagedExecutableSelection,
  type ManagedInstallationsApi,
  type ManagedInstallationsErrorCode,
  type ManagedInstallationsState,
  type ManagedRevisionKind,
  type ManagedRevisionRequest
} from '../installations'
import { resolveManagedInstallationsApi } from '../installationsApi'

/** The renderer's truthful installation-management state. */
export type ManagedInstallationsViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'bridge-unavailable' }
  | { readonly kind: 'error'; readonly code: ManagedInstallationsErrorCode }
  | { readonly kind: 'ready'; readonly data: ManagedInstallationsState }

/** The latest confirmed outcome of an installation-management operation. */
export type ManagedInstallationsFeedback =
  | { readonly kind: 'none' }
  | { readonly kind: 'cancelled'; readonly code: ManagedInstallationsErrorCode }
  | { readonly kind: 'error'; readonly code: ManagedInstallationsErrorCode }
  | { readonly kind: 'toolchain-registered' }
  | { readonly kind: 'bundled-seed-installed' }
  | { readonly kind: 'harness-cloned' }
  | { readonly kind: 'revision-switched' }
  | { readonly kind: 'harness-started' }
  | { readonly kind: 'harness-stopped' }

/** One in-flight installation operation. The renderer never runs two at once. */
export type ManagedInstallationsOperation =
  | { readonly kind: 'load' }
  | { readonly kind: 'select-executable'; readonly executableKind: ManagedExecutableKind }
  | { readonly kind: 'register-toolchain' }
  | { readonly kind: 'install-bundled-seed' }
  | { readonly kind: 'clone-harness' }
  | { readonly kind: 'switch-revision' }
  | { readonly kind: 'start-harness' }
  | { readonly kind: 'stop-harness' }

/**
 * Owns toolchain registration and managed Harness operations through the
 * restricted future preload surface.
 */
export function useManagedInstallations(
  api: ManagedInstallationsApi | undefined = resolveManagedInstallationsApi()
) {
  const state = ref<ManagedInstallationsViewState>({ kind: 'loading' })
  const feedback = ref<ManagedInstallationsFeedback>({ kind: 'none' })
  const activeOperation = ref<ManagedInstallationsOperation>()
  const executableSelections = ref<readonly ManagedExecutableSelection[]>([])
  const selectedWorkspaceId = ref('')
  const selectedToolchainId = ref('')
  const remoteUrl = ref('')
  const cloneRevisionKind = ref<ManagedRevisionKind>()
  const cloneRevisionValue = ref('')
  const selectedInstallationId = ref('')
  const switchRevisionKind = ref<ManagedRevisionKind>()
  const switchRevisionValue = ref('')

  const isBusy = computed(() => activeOperation.value !== undefined)
  const readyData = computed(() => (state.value.kind === 'ready' ? state.value.data : undefined))
  const toolchains = computed(() => readyData.value?.toolchains ?? [])
  const installations = computed(() => readyData.value?.installations ?? [])
  const selectedWorkspaceInstallations = computed(() =>
    selectedWorkspaceId.value
      ? installations.value.filter((entry) => entry.workspaceId === selectedWorkspaceId.value)
      : []
  )
  const selectedInstallation = computed(() =>
    selectedWorkspaceInstallations.value.find(
      (entry) => entry.installationId === selectedInstallationId.value
    )
  )
  const hasSelectedToolchain = computed(() =>
    toolchains.value.some((entry) => entry.toolchainId === selectedToolchainId.value)
  )
  const canRegisterToolchain = computed(
    () =>
      state.value.kind === 'ready' &&
      MANAGED_EXECUTABLE_KINDS.every((kind) => executableSelectionFor(kind) !== undefined) &&
      !isBusy.value
  )
  const canCloneHarness = computed(
    () =>
      state.value.kind === 'ready' &&
      selectedWorkspaceId.value.length > 0 &&
      hasSelectedToolchain.value &&
      remoteUrl.value.trim().length > 0 &&
      cloneRevisionKind.value !== undefined &&
      cloneRevisionValue.value.trim().length > 0 &&
      !isBusy.value
  )
  const canInstallBundledSeed = computed(
    () =>
      state.value.kind === 'ready' &&
      selectedWorkspaceId.value.length > 0 &&
      hasSelectedToolchain.value &&
      selectedWorkspaceInstallations.value.length === 0 &&
      !isBusy.value
  )
  const canSwitchRevision = computed(
    () =>
      state.value.kind === 'ready' &&
      selectedInstallation.value !== undefined &&
      switchRevisionKind.value !== undefined &&
      switchRevisionValue.value.trim().length > 0 &&
      !isBusy.value
  )
  const canStartHarness = computed(
    () =>
      state.value.kind === 'ready' &&
      selectedInstallation.value !== undefined &&
      (selectedInstallation.value.launch.kind === 'stopped' ||
        selectedInstallation.value.launch.kind === 'failed') &&
      !isBusy.value
  )
  const canStopHarness = computed(
    () =>
      state.value.kind === 'ready' &&
      selectedInstallation.value?.launch.kind === 'running' &&
      !isBusy.value
  )

  /** Reads only the state that Electron main currently owns. */
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
      state.value = { kind: 'ready', data: result.data }
      feedback.value = { kind: 'none' }
      clearSelectionsMissingFromState(result.data)
    })
  }

  /** Makes the workspace target explicit and clears a now-invalid installation target. */
  function selectWorkspace(workspaceId: string): void {
    selectedWorkspaceId.value = workspaceId
    selectedInstallationId.value = ''
    switchRevisionKind.value = undefined
    switchRevisionValue.value = ''
  }

  /** Makes the installation target explicit and preserves the selected workspace. */
  function selectInstallation(installationId: string): void {
    selectedInstallationId.value = installationId
    switchRevisionKind.value = undefined
    switchRevisionValue.value = ''
  }

  /** Requests one explicit executable capability without learning its absolute path. */
  async function selectExecutable(kind: ManagedExecutableKind): Promise<void> {
    if (!api || state.value.kind !== 'ready') return
    await run({ kind: 'select-executable', executableKind: kind }, async () => {
      const result = await api.selectExecutable(kind)
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      if (result.data.purpose !== kind) {
        recordOperationFailure('managed.executable_selection_invalid')
        return
      }
      executableSelections.value = [
        ...executableSelections.value.filter((entry) => entry.purpose !== kind),
        result.data
      ]
      feedback.value = { kind: 'none' }
    })
  }

  /** Registers exactly the three selected executable capabilities through main. */
  async function registerToolchain(): Promise<void> {
    if (!api || !canRegisterToolchain.value) return
    const git = executableSelectionFor('git')
    const node = executableSelectionFor('node')
    const pnpm = executableSelectionFor('pnpm')
    if (!git || !node || !pnpm) return
    await run({ kind: 'register-toolchain' }, async () => {
      const result = await api.registerToolchain({
        gitCapabilityId: git.capabilityId,
        nodeCapabilityId: node.capabilityId,
        pnpmCapabilityId: pnpm.capabilityId
      })
      if (!result.ok) {
        // Main may consume an executable capability before a later validation fails.
        executableSelections.value = []
        recordOperationFailure(result.code)
        return
      }
      executableSelections.value = []
      state.value = { kind: 'ready', data: result.data.state }
      selectedToolchainId.value = result.data.toolchainId
      clearSelectionsMissingFromState(result.data.state)
      feedback.value = { kind: 'toolchain-registered' }
    })
  }

  /** Imports the package-provided DSH only through the named main-process seed operation. */
  async function installBundledSeed(): Promise<void> {
    if (!api || !canInstallBundledSeed.value) return
    await run({ kind: 'install-bundled-seed' }, async () => {
      const result = await api.installBundledSeed({
        workspaceId: selectedWorkspaceId.value,
        toolchainId: selectedToolchainId.value
      })
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      state.value = { kind: 'ready', data: result.data }
      clearSelectionsMissingFromState(result.data)
      feedback.value = { kind: 'bundled-seed-installed' }
    })
  }

  /** Clones only the user-selected remote and Git ref into the chosen workspace. */
  async function cloneHarness(): Promise<void> {
    if (!api || !canCloneHarness.value) return
    const revision = createRevisionRequest(cloneRevisionKind.value, cloneRevisionValue.value)
    if (!revision) return
    await run({ kind: 'clone-harness' }, async () => {
      const result = await api.cloneHarness({
        workspaceId: selectedWorkspaceId.value,
        toolchainId: selectedToolchainId.value,
        remoteUrl: remoteUrl.value.trim(),
        revision
      })
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      state.value = { kind: 'ready', data: result.data }
      remoteUrl.value = ''
      cloneRevisionKind.value = undefined
      cloneRevisionValue.value = ''
      clearSelectionsMissingFromState(result.data)
      feedback.value = { kind: 'harness-cloned' }
    })
  }

  /** Switches only the explicitly selected materialized Harness installation. */
  async function switchRevision(): Promise<void> {
    const installation = selectedInstallation.value
    if (!api || !canSwitchRevision.value || !installation) return
    const revision = createRevisionRequest(switchRevisionKind.value, switchRevisionValue.value)
    if (!revision) return
    await run({ kind: 'switch-revision' }, async () => {
      const result = await api.switchRevision({
        workspaceId: selectedWorkspaceId.value,
        installationId: installation.installationId,
        revision
      })
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      state.value = { kind: 'ready', data: result.data }
      switchRevisionKind.value = undefined
      switchRevisionValue.value = ''
      clearSelectionsMissingFromState(result.data)
      feedback.value = { kind: 'revision-switched' }
    })
  }

  /** Starts only the explicitly selected materialized Harness installation. */
  async function startHarness(): Promise<void> {
    const installation = selectedInstallation.value
    if (!api || !canStartHarness.value || !installation) return
    await run({ kind: 'start-harness' }, async () => {
      const result = await api.startHarness({
        workspaceId: selectedWorkspaceId.value,
        installationId: installation.installationId
      })
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      state.value = { kind: 'ready', data: result.data }
      clearSelectionsMissingFromState(result.data)
      feedback.value = { kind: 'harness-started' }
    })
  }

  /** Requests normal shutdown only for the selected accepted child generation. */
  async function stopHarness(): Promise<void> {
    const installation = selectedInstallation.value
    if (!api || !canStopHarness.value || !installation) return
    await run({ kind: 'stop-harness' }, async () => {
      const result = await api.stopHarness({
        workspaceId: selectedWorkspaceId.value,
        installationId: installation.installationId
      })
      if (!result.ok) {
        recordOperationFailure(result.code)
        return
      }
      state.value = { kind: 'ready', data: result.data }
      clearSelectionsMissingFromState(result.data)
      feedback.value = { kind: 'harness-stopped' }
    })
  }

  /** Returns the display-only one-use capability for one executable role. */
  function executableSelectionFor(
    kind: ManagedExecutableKind
  ): ManagedExecutableSelection | undefined {
    return executableSelections.value.find((entry) => entry.purpose === kind)
  }

  function recordOperationFailure(code: ManagedInstallationsErrorCode): void {
    feedback.value =
      code === 'managed.selection_cancelled' ? { kind: 'cancelled', code } : { kind: 'error', code }
  }

  function clearSelectionsMissingFromState(nextState: ManagedInstallationsState): void {
    if (!nextState.toolchains.some((entry) => entry.toolchainId === selectedToolchainId.value)) {
      selectedToolchainId.value = ''
    }
    if (
      !nextState.installations.some(
        (entry) =>
          entry.workspaceId === selectedWorkspaceId.value &&
          entry.installationId === selectedInstallationId.value
      )
    ) {
      selectedInstallationId.value = ''
      switchRevisionKind.value = undefined
      switchRevisionValue.value = ''
    }
  }

  async function run(
    operation: ManagedInstallationsOperation,
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
    canCloneHarness,
    canInstallBundledSeed,
    canRegisterToolchain,
    canStartHarness,
    canStopHarness,
    canSwitchRevision,
    cloneHarness,
    cloneRevisionKind,
    cloneRevisionValue,
    executableSelectionFor,
    feedback,
    initialize,
    installBundledSeed,
    installations,
    isBusy,
    remoteUrl,
    registerToolchain,
    selectExecutable,
    selectedInstallation,
    selectedInstallationId,
    selectedToolchainId,
    selectedWorkspaceId,
    selectedWorkspaceInstallations,
    selectInstallation,
    selectWorkspace,
    startHarness,
    state,
    stopHarness,
    switchRevision,
    switchRevisionKind,
    switchRevisionValue,
    toolchains
  }
}

/** Prevents a blank local form from becoming a synthetic branch or commit request. */
function createRevisionRequest(
  kind: ManagedRevisionKind | undefined,
  value: string
): ManagedRevisionRequest | undefined {
  const trimmedValue = value.trim()
  if (!kind || !trimmedValue) return undefined
  switch (kind) {
    case 'branch':
      return { kind, value: trimmedValue }
    case 'tag':
      return { kind, value: trimmedValue }
    case 'commit':
      return { kind, value: trimmedValue }
  }
}
