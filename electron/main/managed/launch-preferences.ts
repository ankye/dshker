import {
  LAUNCHER_HARNESS_MAX_PORT,
  LAUNCHER_HARNESS_MIN_PORT,
  type LauncherHarnessPortSetting
} from '../../../src/shared/contracts'
import { ManagedHarnessRuntimeError } from './runtime-errors'

/** Persisted document identity for the Launcher-owned DSH launch preferences. */
export const LAUNCH_PREFERENCES_FORMAT = 'dsh-launcher.launch-preferences' as const

/** Admits only an automatic selection or an unprivileged integer port. */
export function assertPortSetting(value: LauncherHarnessPortSetting): LauncherHarnessPortSetting {
  if (value.mode === 'auto') return { mode: 'auto' }
  if (
    !Number.isSafeInteger(value.port) ||
    value.port < LAUNCHER_HARNESS_MIN_PORT ||
    value.port > LAUNCHER_HARNESS_MAX_PORT
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      `A fixed DSH web port must be an integer between ${LAUNCHER_HARNESS_MIN_PORT} and ${LAUNCHER_HARNESS_MAX_PORT}.`
    )
  }
  return { mode: 'fixed', port: value.port }
}

/** Reads a persisted port, returning automatic mode only for an unusable Launcher record. */
export function parseLaunchPreferencesPort(text: string): LauncherHarnessPortSetting {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { mode: 'auto' }
  }
  if (typeof document !== 'object' || document === null) return { mode: 'auto' }
  const record = document as Record<string, unknown>
  if (record.format !== LAUNCH_PREFERENCES_FORMAT) return { mode: 'auto' }
  const port = record.port
  if (typeof port !== 'object' || port === null) return { mode: 'auto' }
  const candidate = port as Record<string, unknown>
  if (candidate.mode !== 'fixed') return { mode: 'auto' }
  try {
    return assertPortSetting({ mode: 'fixed', port: candidate.port as number })
  } catch {
    return { mode: 'auto' }
  }
}
