/** The four mutually exclusive filesystem ownership roles of DSH Launcher. */
export const MANAGED_ROOT_KINDS = ['harness', 'plugins', 'presets', 'settings'] as const

/** One independently registered root role. */
export type ManagedRootKind = (typeof MANAGED_ROOT_KINDS)[number]

/** Persisted document identity for the Launcher-owned root registry. */
export const MANAGED_ROOT_REGISTRY_FORMAT = 'dsh-launcher.managed-root-registry' as const

/** The first launcher-owned persisted root-registry format. */
export const MANAGED_ROOT_REGISTRY_VERSION = 2 as const

/** A canonical application-level root. */
export interface ManagedRootRegistration {
  readonly rootId: string
  readonly kind: ManagedRootKind
  readonly canonicalPath: string
}

/** One workspace-relative namespace below a registered root. */
export interface WorkspaceRootNamespace {
  readonly rootId: string
  readonly namespace: string
}

/** Launcher workspace state that references roots without duplicating their paths. */
export interface ManagedWorkspaceBinding {
  readonly workspaceId: string
  readonly displayName: string
  readonly workingDirectoryCapabilityId: string
  readonly workingDirectoryCanonicalPath: string
  readonly rootNamespaces: readonly WorkspaceRootNamespace[]
}

/** The complete Launcher-owned registry stored below the selected Settings root. */
export interface ManagedRootRegistry {
  readonly format: typeof MANAGED_ROOT_REGISTRY_FORMAT
  readonly version: typeof MANAGED_ROOT_REGISTRY_VERSION
  readonly roots: readonly ManagedRootRegistration[]
  readonly workspaces: readonly ManagedWorkspaceBinding[]
}

/** Tests whether a value names one of the four managed root roles. */
export function isManagedRootKind(value: string): value is ManagedRootKind {
  return (MANAGED_ROOT_KINDS as readonly string[]).includes(value)
}
