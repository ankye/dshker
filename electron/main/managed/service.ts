import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type {
  CreateManagedWorkspaceRequest,
  DirectorySelectionPurpose,
  ManagedDirectorySelection,
  ManagedLauncherState,
  RegisterManagedRootsRequest
} from '../../../src/shared/contracts'
import {
  createManagedBootstrapLocator,
  type ManagedBootstrapLocatorStore
} from './bootstrap-locator'
import {
  type DirectoryPicker,
  type DirectorySelectionCapabilities,
  type DirectorySelectionCapability
} from './capabilities'
import { ManagedRootError } from './errors'
import {
  assertEmptyManagedRoot,
  assertRegisteredDirectory,
  canonicalizeSelectedDirectory,
  ensureRegistryDirectory,
  managedRootRegistryFilePath
} from './filesystem'
import {
  createEmptyManagedInstallationCatalog,
  ManagedInstallationCatalogStore,
  managedInstallationCatalogFilePath,
  type ManagedInstallationCatalog
} from './installation-catalog'
import {
  MANAGED_ROOT_KINDS,
  MANAGED_ROOT_REGISTRY_FORMAT,
  MANAGED_ROOT_REGISTRY_VERSION,
  type ManagedRootKind,
  type ManagedRootRegistration,
  type ManagedRootRegistry,
  type ManagedWorkspaceBinding
} from './model'
import { ManagedRootRegistryStore } from './registry'
import type { ManagedPathStyle } from './validation'
import {
  assertManagedRootLayout,
  assertWorkspaceBinding,
  assertWorkspaceDisplayName
} from './validation'
import {
  createManagedWorkspaceDirectories,
  readManagedWorkspaceDirectories,
  removeManagedWorkspaceDirectories,
  type ManagedWorkspaceDirectories
} from './workspace-directories'
import { createDesktopWorkspaceProfileArtifacts } from './workspace-profile-artifacts'

/** Constructor dependencies intentionally supplied by Electron main rather than read from ambient state. */
export interface ManagedWorkspaceServiceOptions {
  readonly locator: ManagedBootstrapLocatorStore
  readonly capabilities: DirectorySelectionCapabilities
  readonly directoryPicker: DirectoryPicker
  readonly pathStyle: ManagedPathStyle
  /** Native DSH home preserved across all managed Harness revisions. */
  readonly nativeDshHomePath: string
  /** Launcher-owned roots created on first launch without asking the user to configure storage. */
  readonly defaultRootPaths: Readonly<Record<ManagedRootKind, string>>
}

/** One registered workspace together with its resolved Launcher-owned namespace directories. */
export interface ResolvedManagedWorkspace {
  readonly workspace: ManagedWorkspaceBinding
  readonly roots: readonly ManagedRootRegistration[]
  readonly directories: ManagedWorkspaceDirectories
}

/** Owns setup, root registration, and workspace bindings for the launcher process. */
export class ManagedWorkspaceService {
  readonly #locator: ManagedBootstrapLocatorStore
  readonly #capabilities: DirectorySelectionCapabilities
  readonly #directoryPicker: DirectoryPicker
  readonly #pathStyle: ManagedPathStyle
  readonly #nativeDshHomePath: string
  readonly #defaultRootPaths: Readonly<Record<ManagedRootKind, string>>
  #mutationActive = false

  constructor(options: ManagedWorkspaceServiceOptions) {
    this.#locator = options.locator
    this.#capabilities = options.capabilities
    this.#directoryPicker = options.directoryPicker
    this.#pathStyle = options.pathStyle
    this.#nativeDshHomePath = options.nativeDshHomePath
    this.#defaultRootPaths = options.defaultRootPaths
  }

  /** Projects current persistence health without creating a root or guessing a path. */
  async getState(): Promise<ManagedLauncherState> {
    try {
      const registry = await this.#loadReadyRegistry()
      return projectReadyState(registry)
    } catch (error) {
      if (!(error instanceof ManagedRootError)) {
        throw error
      }
      if (error.code === 'managed.missing_bootstrap_locator') {
        return { kind: 'setup-required', code: error.code }
      }
      return { kind: 'recovery-required', code: error.code }
    }
  }

  /** Creates product defaults exactly once so first run never asks users to arrange storage. */
  async initializeDefaultRoots(): Promise<ManagedLauncherState> {
    const state = await this.getState()
    if (state.kind !== 'setup-required') return state
    return projectReadyState(await this.#registerDefaultRoots())
  }

  /** Opens a native directory picker for one named purpose and issues a short-lived capability. */
  async selectDirectory(purpose: DirectorySelectionPurpose): Promise<ManagedDirectorySelection> {
    const selectedPath = await this.#directoryPicker.pickDirectory(purpose)
    if (selectedPath === undefined) {
      throw new ManagedRootError(
        'managed.selection_cancelled',
        'Directory selection was cancelled.'
      )
    }
    const canonicalPath = await canonicalizeSelectedDirectory(selectedPath, this.#pathStyle)
    const capability = this.#capabilities.issue(
      purpose,
      canonicalPath,
      displayNameFor(canonicalPath)
    )
    return projectSelection(capability)
  }

  /** Consumes one native-selected source directory for the plugin materializer. */
  consumePluginSourceDirectory(capabilityId: string): string {
    return this.#capabilities.consume(capabilityId, 'plugin-source').canonicalPath
  }

  /** Commits the exactly four selected roots after all filesystem and topology checks succeed. */
  async registerRoots(request: RegisterManagedRootsRequest): Promise<ManagedLauncherState> {
    return this.#runExclusive(async () => {
      await this.#assertInitialSetup()
      const selections = assertRootSelections(request)
      const candidates = await Promise.all(
        selections.map(async (selection) => {
          const capability = this.#capabilities.inspect(
            selection.capabilityId,
            `managed-root:${selection.kind}`
          )
          const canonicalPath = await canonicalizeSelectedDirectory(
            capability.canonicalPath,
            this.#pathStyle
          )
          return { kind: selection.kind, capability, canonicalPath }
        })
      )
      const roots = candidates.map(
        ({ kind, canonicalPath }): ManagedRootRegistration => ({
          rootId: newOpaqueId('root'),
          kind,
          canonicalPath
        })
      )
      assertManagedRootLayout(roots, this.#pathStyle, this.#nativeDshHomePath)
      await Promise.all(roots.map((root) => assertEmptyManagedRoot(root.canonicalPath)))

      const settingsRoot = roots.find((root) => root.kind === 'settings')
      if (!settingsRoot) {
        throw new ManagedRootError('managed.invalid_record', 'Settings root selection is missing.')
      }
      const registryDirectory = await ensureRegistryDirectory(
        settingsRoot.canonicalPath,
        this.#pathStyle
      )
      const registryStore = new ManagedRootRegistryStore({
        filePath: managedRootRegistryFilePath(settingsRoot.canonicalPath, this.#pathStyle),
        pathStyle: this.#pathStyle,
        nativeDshHomePath: this.#nativeDshHomePath
      })
      const catalogStore = new ManagedInstallationCatalogStore({
        filePath: managedInstallationCatalogFilePath(settingsRoot.canonicalPath, this.#pathStyle),
        pathStyle: this.#pathStyle
      })
      const registry: ManagedRootRegistry = {
        format: MANAGED_ROOT_REGISTRY_FORMAT,
        version: MANAGED_ROOT_REGISTRY_VERSION,
        roots,
        workspaces: []
      }

      for (const candidate of candidates) {
        this.#capabilities.consume(
          candidate.capability.capabilityId,
          `managed-root:${candidate.kind}`
        )
      }
      await this.#locator.save(createManagedBootstrapLocator(settingsRoot.canonicalPath))
      await registryStore.save(registry)
      await catalogStore.save(createEmptyManagedInstallationCatalog())
      await assertRegisteredDirectory(registryDirectory, this.#pathStyle)
      return projectReadyState(registry)
    })
  }

  /** Adds one workspace binding using a separately selected working-directory capability. */
  async createWorkspace(request: CreateManagedWorkspaceRequest): Promise<ManagedLauncherState> {
    return this.#runExclusive(async () => {
      assertWorkspaceDisplayName(request.displayName)
      const { locator, registry, store } = await this.#loadReadyRegistryWithStore()
      const capability = this.#capabilities.inspect(
        request.workingDirectoryCapabilityId,
        'workspace-working-directory'
      )
      const workingDirectoryCanonicalPath = await canonicalizeSelectedDirectory(
        capability.canonicalPath,
        this.#pathStyle
      )
      const workspaceId = newOpaqueId('workspace')
      const namespace = `workspaces/${workspaceId}`
      const workspace: ManagedWorkspaceBinding = {
        workspaceId,
        displayName: request.displayName,
        workingDirectoryCapabilityId: capability.capabilityId,
        workingDirectoryCanonicalPath,
        rootNamespaces: registry.roots.map((root) => ({ rootId: root.rootId, namespace }))
      }
      assertWorkspaceBinding(workspace, registry.roots, this.#pathStyle, this.#nativeDshHomePath)
      const nextRegistry: ManagedRootRegistry = {
        ...registry,
        workspaces: [...registry.workspaces, workspace]
      }

      this.#capabilities.consume(capability.capabilityId, 'workspace-working-directory')
      const directories = await createManagedWorkspaceDirectories(
        registry.roots,
        workspace,
        this.#pathStyle
      )
      let profileArtifacts: Awaited<ReturnType<typeof createDesktopWorkspaceProfileArtifacts>>
      try {
        profileArtifacts = await createDesktopWorkspaceProfileArtifacts(directories)
      } catch (error) {
        try {
          await removeManagedWorkspaceDirectories(directories)
        } catch (cleanupError) {
          throw new ManagedRootError(
            'managed.persistence_failed',
            'Initial workspace directories could not be removed after desktop settings setup failed.',
            { cause: cleanupError instanceof Error ? cleanupError.name : 'unknown' }
          )
        }
        throw error
      }
      try {
        await store.save(nextRegistry)
      } catch (error) {
        try {
          await profileArtifacts.remove()
          await removeManagedWorkspaceDirectories(directories)
        } catch (cleanupError) {
          throw new ManagedRootError(
            'managed.persistence_failed',
            'Workspace registration failed and its initial directories could not be removed.',
            { cause: cleanupError instanceof Error ? cleanupError.name : 'unknown' }
          )
        }
        throw error
      }
      if (
        locator.settingsRootCanonicalPath !== rootByKind(nextRegistry, 'settings').canonicalPath
      ) {
        throw new ManagedRootError(
          'managed.invalid_bootstrap_locator',
          'Registered Settings root differs from the bootstrap locator.'
        )
      }
      return projectReadyState(nextRegistry)
    })
  }

  /** Returns one binding only after the persisted registry and all registered roots are readable. */
  async getWorkspace(workspaceId: string): Promise<ManagedWorkspaceBinding> {
    const registry = await this.#loadReadyRegistry()
    const workspace = registry.workspaces.find((entry) => entry.workspaceId === workspaceId)
    if (!workspace) {
      throw new ManagedRootError(
        'managed.workspace_not_found',
        'Managed workspace is not registered.'
      )
    }
    return workspace
  }

  /** Resolves every existing Launcher-owned workspace directory after registry and filesystem revalidation. */
  async getWorkspaceDirectories(workspaceId: string): Promise<ResolvedManagedWorkspace> {
    const registry = await this.#loadReadyRegistry()
    const workspace = registry.workspaces.find((entry) => entry.workspaceId === workspaceId)
    if (!workspace) {
      throw new ManagedRootError(
        'managed.workspace_not_found',
        'Managed workspace is not registered.'
      )
    }
    return {
      workspace,
      roots: registry.roots,
      directories: await readManagedWorkspaceDirectories(registry.roots, workspace, this.#pathStyle)
    }
  }

  /** Reads the complete installation catalog only after the root registry is still healthy. */
  async getInstallationCatalog(): Promise<ManagedInstallationCatalog> {
    const { catalogStore } = await this.#loadReadyRegistryWithStore()
    return catalogStore.load()
  }

  /** Replaces the complete catalog after revalidating the persisted root registry. */
  async saveInstallationCatalog(catalog: ManagedInstallationCatalog): Promise<void> {
    const { catalogStore } = await this.#loadReadyRegistryWithStore()
    await catalogStore.save(catalog)
  }

  async #assertInitialSetup(): Promise<void> {
    try {
      await this.#locator.load()
    } catch (error) {
      if (error instanceof ManagedRootError && error.code === 'managed.missing_bootstrap_locator')
        return
      throw error
    }
    throw new ManagedRootError(
      'managed.setup_already_complete',
      'Managed roots are already registered.'
    )
  }

  /** Creates the product's four private storage roots only when no Launcher state exists. */
  async #registerDefaultRoots(): Promise<ManagedRootRegistry> {
    return this.#runExclusive(async () => {
      await this.#assertInitialSetup()
      const roots = await Promise.all(
        MANAGED_ROOT_KINDS.map(async (kind): Promise<ManagedRootRegistration> => {
          const requestedPath = this.#defaultRootPaths[kind]
          try {
            await mkdir(requestedPath, { recursive: true })
          } catch (error) {
            if (!isNodeCode(error, 'EEXIST')) throw error
          }
          const canonicalPath = await canonicalizeSelectedDirectory(requestedPath, this.#pathStyle)
          return { rootId: newOpaqueId('root'), kind, canonicalPath }
        })
      )
      assertManagedRootLayout(roots, this.#pathStyle, this.#nativeDshHomePath)
      const settingsRoot = roots.find((root) => root.kind === 'settings')
      if (!settingsRoot) {
        throw new ManagedRootError('managed.invalid_record', 'Default Settings root is missing.')
      }
      const registryDirectory = await ensureRegistryDirectory(
        settingsRoot.canonicalPath,
        this.#pathStyle
      )
      const registry: ManagedRootRegistry = {
        format: MANAGED_ROOT_REGISTRY_FORMAT,
        version: MANAGED_ROOT_REGISTRY_VERSION,
        roots,
        workspaces: []
      }
      const registryStore = new ManagedRootRegistryStore({
        filePath: managedRootRegistryFilePath(settingsRoot.canonicalPath, this.#pathStyle),
        pathStyle: this.#pathStyle,
        nativeDshHomePath: this.#nativeDshHomePath
      })
      const catalogStore = new ManagedInstallationCatalogStore({
        filePath: managedInstallationCatalogFilePath(settingsRoot.canonicalPath, this.#pathStyle),
        pathStyle: this.#pathStyle
      })
      await this.#locator.save(createManagedBootstrapLocator(settingsRoot.canonicalPath))
      await registryStore.save(registry)
      await catalogStore.save(createEmptyManagedInstallationCatalog())
      await assertRegisteredDirectory(registryDirectory, this.#pathStyle)
      return registry
    })
  }

  async #loadReadyRegistry(): Promise<ManagedRootRegistry> {
    return (await this.#loadReadyRegistryWithStore()).registry
  }

  async #loadReadyRegistryWithStore(): Promise<{
    readonly locator: Awaited<ReturnType<ManagedBootstrapLocatorStore['load']>>
    readonly registry: ManagedRootRegistry
    readonly store: ManagedRootRegistryStore
    readonly catalogStore: ManagedInstallationCatalogStore
  }> {
    const locator = await this.#locator.load()
    await assertRegisteredDirectory(locator.settingsRootCanonicalPath, this.#pathStyle)
    const store = new ManagedRootRegistryStore({
      filePath: managedRootRegistryFilePath(locator.settingsRootCanonicalPath, this.#pathStyle),
      pathStyle: this.#pathStyle,
      nativeDshHomePath: this.#nativeDshHomePath
    })
    const registry = await store.load()
    const catalogStore = new ManagedInstallationCatalogStore({
      filePath: managedInstallationCatalogFilePath(
        locator.settingsRootCanonicalPath,
        this.#pathStyle
      ),
      pathStyle: this.#pathStyle
    })
    await catalogStore.load()
    const settingsRoot = rootByKind(registry, 'settings')
    if (settingsRoot.canonicalPath !== locator.settingsRootCanonicalPath) {
      throw new ManagedRootError(
        'managed.invalid_bootstrap_locator',
        'Launcher bootstrap locator and registered Settings root differ.'
      )
    }
    await Promise.all(
      registry.roots.map((root) => assertRegisteredDirectory(root.canonicalPath, this.#pathStyle))
    )
    await Promise.all(
      registry.workspaces.map((workspace) =>
        assertRegisteredDirectory(workspace.workingDirectoryCanonicalPath, this.#pathStyle)
      )
    )
    return { locator, registry, store, catalogStore }
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#mutationActive) {
      throw new ManagedRootError(
        'managed.operation_in_progress',
        'Another managed-root operation is in progress.'
      )
    }
    this.#mutationActive = true
    try {
      return await operation()
    } finally {
      this.#mutationActive = false
    }
  }
}

function assertRootSelections(request: RegisterManagedRootsRequest): readonly {
  readonly kind: ManagedRootKind
  readonly capabilityId: string
}[] {
  if (
    !request ||
    !Array.isArray(request.selections) ||
    request.selections.length !== MANAGED_ROOT_KINDS.length
  ) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Exactly four root selections are required.'
    )
  }
  const selectedKinds = new Set<ManagedRootKind>()
  for (const selection of request.selections) {
    if (
      !selection ||
      typeof selection !== 'object' ||
      !MANAGED_ROOT_KINDS.includes(selection.kind) ||
      typeof selection.capabilityId !== 'string' ||
      selectedKinds.has(selection.kind)
    ) {
      throw new ManagedRootError('managed.selection_invalid', 'Root selections are invalid.')
    }
    selectedKinds.add(selection.kind)
  }
  return request.selections
}

function rootByKind(registry: ManagedRootRegistry, kind: ManagedRootKind): ManagedRootRegistration {
  const root = registry.roots.find((entry) => entry.kind === kind)
  if (!root) {
    throw new ManagedRootError('managed.invalid_record', 'Registered root inventory is incomplete.')
  }
  return root
}

function displayNameFor(canonicalPath: string): string {
  const slash = Math.max(canonicalPath.lastIndexOf('/'), canonicalPath.lastIndexOf('\\'))
  const name = canonicalPath.slice(slash + 1)
  if (!name) {
    throw new ManagedRootError(
      'managed.selection_invalid',
      'Selected directory display name is unavailable.'
    )
  }
  return name
}

function newOpaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}

function projectSelection(capability: DirectorySelectionCapability): ManagedDirectorySelection {
  return {
    capabilityId: capability.capabilityId,
    purpose: capability.purpose,
    displayName: capability.displayName
  }
}

function projectReadyState(registry: ManagedRootRegistry): ManagedLauncherState {
  return {
    kind: 'ready',
    roots: registry.roots.map((root) => ({
      rootId: root.rootId,
      kind: root.kind,
      canonicalPath: root.canonicalPath
    })),
    workspaces: registry.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      displayName: workspace.displayName,
      workingDirectoryCanonicalPath: workspace.workingDirectoryCanonicalPath,
      rootNamespaces: workspace.rootNamespaces.map((binding) => ({ ...binding }))
    }))
  }
}
