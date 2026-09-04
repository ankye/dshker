import { runText } from './process-utils'

/**
 * Platform-safe argument prefix for the Launcher's own Git commands.
 *
 * pnpm's nested node_modules can nest far past Windows' 260-character path
 * limit; without long-path file APIs `git clean` fails mid-deletion and bricks
 * the only checkout. Mirrors the managed-git runner's deterministic prefix.
 */
export function launcherGitArguments(arguments_: readonly string[]): readonly string[] {
  return process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...arguments_] : arguments_
}

/** Direct pnpm launch facts for platforms whose registered pnpm is a shell shim. */
export interface PnpmCommandLauncher {
  readonly executable: string
  readonly prefixArguments: readonly string[]
  /** PATH required by pnpm's shell entrypoint and its subprocesses. */
  readonly commandSearchPath: string
}

/** Resolves the direct pnpm command, forwarding shim-prefix arguments when present. */
export function resolvePnpmCommand(
  pnpmExecutable: string,
  launcher: PnpmCommandLauncher | undefined,
  arguments_: readonly string[]
): Readonly<{ executable: string; arguments: readonly string[] }> {
  if (launcher === undefined) {
    return { executable: pnpmExecutable, arguments: arguments_ }
  }
  return {
    executable: launcher.executable,
    arguments: [...launcher.prefixArguments, ...arguments_]
  }
}

/** Supplies the Launcher-resolved command PATH to every pnpm invocation. */
export function pnpmCommandEnvironment(
  launcher: PnpmCommandLauncher | undefined
): NodeJS.ProcessEnv | undefined {
  const commandSearchPath = launcher?.commandSearchPath
  return commandSearchPath === undefined ? undefined : { ...process.env, PATH: commandSearchPath }
}

/** Removes untracked and ignored build residue from a verified Launcher checkout. */
export async function cleanLauncherHarnessCheckout(
  gitExecutable: string,
  harnessDirectory: string
): Promise<void> {
  await runText(gitExecutable, launcherGitArguments(['-C', harnessDirectory, 'clean', '-xdf']))
}

/** Builds the standard DSH forwarder invocation for the native web profile. */
export function launcherProfilePluginArguments(
  operation: 'add' | 'remove' | 'update',
  target?: string
): readonly string[] {
  return [
    'dsh',
    'plugin',
    '--profile',
    'web',
    operation,
    ...(target === undefined ? [] : [target]),
    // Removing an installed package must not wait for the registry. Every
    // artifact needed to unlink it is already present in this profile.
    ...(operation === 'remove' ? ['--config.offline=true'] : [])
  ]
}
