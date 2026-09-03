import { runText } from './process-utils'

/** Removes untracked and ignored build residue from a verified Launcher checkout. */
export async function cleanLauncherHarnessCheckout(
  gitExecutable: string,
  harnessDirectory: string
): Promise<void> {
  await runText(gitExecutable, ['-C', harnessDirectory, 'clean', '-xdf'])
}

/** Builds the standard DSH forwarder invocation for the native web profile. */
export function launcherProfilePluginArguments(
  operation: 'add' | 'remove' | 'update',
  target?: string
): readonly string[] {
  return ['dsh', 'plugin', '--profile', 'web', operation, ...(target === undefined ? [] : [target])]
}
