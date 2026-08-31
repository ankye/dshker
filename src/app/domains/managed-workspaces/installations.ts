import type {
  CloneManagedHarnessRequest,
  DesktopApi,
  DesktopApiErrorCode,
  InstallBundledHarnessSeedRequest,
  ManagedExecutableKind,
  ManagedExecutableSelection,
  ManagedHarnessInstallationView,
  ManagedInstallationsState,
  ManagedRevisionRequest,
  ManagedToolchainView,
  RegisterManagedToolchainRequest,
  RegisterManagedToolchainResult,
  StartManagedHarnessRequest,
  StopManagedHarnessRequest,
  SwitchManagedHarnessRevisionRequest
} from '@/shared/contracts'

/** The explicit executable roles required to materialize and run a managed Harness checkout. */
export const MANAGED_EXECUTABLE_KINDS = [
  'git',
  'node',
  'pnpm'
] as const satisfies readonly ManagedExecutableKind[]

/** A requested Git ref category. The renderer never derives a ref from another field. */
export type ManagedRevisionKind = ManagedRevisionRequest['kind']

/** The shared, restricted preload capability for installation management. */
export type ManagedInstallationsApi = DesktopApi['managedInstallations']

/** Installation-management failures remain diagnostic codes rather than renderer decisions. */
export type ManagedInstallationsErrorCode = DesktopApiErrorCode

export type {
  CloneManagedHarnessRequest,
  InstallBundledHarnessSeedRequest,
  ManagedExecutableKind,
  ManagedExecutableSelection,
  ManagedHarnessInstallationView,
  ManagedInstallationsState,
  ManagedRevisionRequest,
  ManagedToolchainView,
  RegisterManagedToolchainRequest,
  RegisterManagedToolchainResult,
  StartManagedHarnessRequest,
  StopManagedHarnessRequest,
  SwitchManagedHarnessRevisionRequest
}
