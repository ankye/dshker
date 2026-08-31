import type {
  DirectorySelectionPurpose,
  DesktopApiErrorCode,
  ManagedDirectorySelection,
  ManagedLauncherState,
  ManagedRootKind
} from '@/shared/contracts'

/** The only four Launcher-owned directory roles accepted during first-run setup. */
export const MANAGED_ROOT_SETUP_ITEMS = [
  {
    kind: 'harness',
    purpose: 'managed-root:harness',
    labelKey: 'managed.root.harness.label',
    descriptionKey: 'managed.root.harness.description'
  },
  {
    kind: 'plugins',
    purpose: 'managed-root:plugins',
    labelKey: 'managed.root.plugins.label',
    descriptionKey: 'managed.root.plugins.description'
  },
  {
    kind: 'presets',
    purpose: 'managed-root:presets',
    labelKey: 'managed.root.presets.label',
    descriptionKey: 'managed.root.presets.description'
  },
  {
    kind: 'settings',
    purpose: 'managed-root:settings',
    labelKey: 'managed.root.settings.label',
    descriptionKey: 'managed.root.settings.description'
  }
] as const satisfies readonly {
  readonly kind: ManagedRootKind
  readonly purpose: DirectorySelectionPurpose
  readonly labelKey:
    | 'managed.root.harness.label'
    | 'managed.root.plugins.label'
    | 'managed.root.presets.label'
    | 'managed.root.settings.label'
  readonly descriptionKey:
    | 'managed.root.harness.description'
    | 'managed.root.plugins.description'
    | 'managed.root.presets.description'
    | 'managed.root.settings.description'
}[]

/** A selected directory authority is display-only until all root roles are selected. */
export interface RootSelectionView {
  readonly kind: ManagedRootKind
  readonly selection: ManagedDirectorySelection
}

/** The renderer's honest projection of native launcher state. */
export type ManagedWorkspacesViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'bridge-unavailable' }
  | { readonly kind: 'error'; readonly code: DesktopApiErrorCode }
  | Extract<ManagedLauncherState, { readonly kind: 'setup-required' }>
  | Extract<ManagedLauncherState, { readonly kind: 'recovery-required' }>
  | Extract<ManagedLauncherState, { readonly kind: 'ready' }>

/** The last native action result. It never invents a successful state. */
export type ManagedWorkspacesFeedback =
  | { readonly kind: 'none' }
  | { readonly kind: 'cancelled'; readonly code: 'managed.selection_cancelled' }
  | { readonly kind: 'error'; readonly code: DesktopApiErrorCode }
  | { readonly kind: 'roots-registered' }
  | { readonly kind: 'workspace-created' }

/** One active native operation; serializing renderer actions avoids ambiguous selection authority. */
export type ManagedWorkspacesOperation =
  | { readonly kind: 'load' }
  | { readonly kind: 'select-root'; readonly rootKind: ManagedRootKind }
  | { readonly kind: 'register-roots' }
  | { readonly kind: 'select-working-directory' }
  | { readonly kind: 'create-workspace' }
