import type {
  LauncherHarnessConsoleEntry,
  LauncherHarnessPortSetting
} from '../../../src/shared/contracts'
import type { ManagedPluginInstallSource } from './managed-plugin-sources'

/**
 * Pure Console record formatters.
 *
 * They carry no service state so the streaming service, its tests, and any
 * future consumer format identical records for the same activity.
 */

/** Formats one Launcher-owned lifecycle event for both the durable log and live Console view. */
export function formatLauncherLifecycleEvent(message: string): string {
  return `[launcher] ${message}\n`
}

/** Formats the Console record that explains why a Launcher operation failed. */
export function formatLauncherOperationFailure(description: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : 'unknown error'
  return `${description} failed: ${reason}`
}

/**
 * Formats a step's completion with its elapsed seconds.
 *
 * `git clean` and long installs print nothing while they run; the elapsed line
 * is what tells the user a silent step is progressing rather than frozen.
 */
export function formatLauncherStepCompletion(
  description: string,
  elapsedMilliseconds: number
): string {
  return `${description} finished in ${Math.round(elapsedMilliseconds / 1000)}s.`
}

/**
 * Formats the recurring heartbeat for a step that has stayed silent.
 *
 * Steps whose child prints nothing (a Windows `git clean` of a full
 * node_modules can run for many minutes) re-assert themselves on the console
 * so the feed keeps changing instead of looking frozen.
 */
export function formatLauncherStepHeartbeat(
  description: string,
  elapsedMilliseconds: number
): string {
  return `${description} still running (${Math.round(elapsedMilliseconds / 1000)}s elapsed)…`
}

/** Names one plugin install source in Console records without leaking a raw request object. */
export function describePluginInstallSource(source: ManagedPluginInstallSource): string {
  if (source.kind === 'git') return `plugin from ${source.url}`
  if (source.kind === 'local') return `plugin from local directory ${source.path}`
  return `plugin archive ${source.path}`
}

/** Builds the exact DSH command, including Launcher-owned verbose logging for this child. */
export function launcherWebStartArguments(
  diagnosticsPatchPath: string,
  port: LauncherHarnessPortSetting
): readonly string[] {
  return [
    'dsh',
    'web',
    '--patch',
    diagnosticsPatchPath,
    '--no-open',
    ...(port.mode === 'fixed' ? ['--port', String(port.port)] : [])
  ]
}

/** Separates pnpm's one-line script echo from diagnostics written to standard error. */
export function classifyChildConsoleStream(
  stream: 'stdout' | 'stderr',
  text: string
): LauncherHarnessConsoleEntry['stream'] {
  return stream === 'stderr' && /^\$\s+\S[^\r\n]*(?:\r?\n)?$/u.test(text) ? 'command' : stream
}
