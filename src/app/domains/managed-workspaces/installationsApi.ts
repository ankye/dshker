import type { DesktopApi } from '@/shared/contracts'
import type { ManagedInstallationsApi } from './installations'

/**
 * Resolves the typed installation-management bridge in one place.
 *
 * The renderer treats an absent or malformed preload object as unavailable
 * instead of guessing from browser state. The structural guard is retained in
 * this adapter so no component needs an unchecked preload cast.
 */
export function resolveManagedInstallationsApi(
  desktopApi: DesktopApi | undefined = window.dshLauncher
): ManagedInstallationsApi | undefined {
  if (!desktopApi) return undefined
  const candidate = desktopApi.managedInstallations
  return isManagedInstallationsApi(candidate) ? candidate : undefined
}

function isManagedInstallationsApi(value: unknown): value is ManagedInstallationsApi {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.getState === 'function' &&
    typeof record.selectExecutable === 'function' &&
    typeof record.registerToolchain === 'function' &&
    typeof record.installBundledSeed === 'function' &&
    typeof record.cloneHarness === 'function' &&
    typeof record.switchRevision === 'function' &&
    typeof record.startHarness === 'function' &&
    typeof record.stopHarness === 'function'
  )
}
