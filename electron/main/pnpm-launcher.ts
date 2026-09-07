import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** A direct executable invocation suitable for Node's shell-free spawn. */
export interface PnpmLauncher {
  readonly resolutionError?: string
  readonly executable: string
  readonly prefixArguments: readonly string[]
  /** PATH supplied to pnpm, whose POSIX entry script resolves `node` through env. */
  readonly commandSearchPath: string
}

/**
 * Resolves pnpm for the desktop process rather than trusting Finder or Explorer's reduced PATH.
 *
 * macOS and Linux run a real executable. Windows registers a `.CMD` shim which
 * shell-free spawn cannot execute, so it resolves the shim's adjacent pnpm Node
 * entry and invokes it with Node instead.
 */
export function resolvePnpmLauncher(): PnpmLauncher {
  if (process.platform === 'win32') return resolveWindowsPnpmLauncher()
  const executable = findPosixPnpmExecutable()
  return {
    executable: executable ?? 'pnpm',
    prefixArguments: [],
    commandSearchPath: buildCommandSearchPath(executable)
  }
}

/** Resolves a real pnpm binary from inherited PATH plus platform package-manager locations. */
function findPosixPnpmExecutable(): string | undefined {
  const directories = new Set([
    ...splitPath(process.env.PATH),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homedir(), '.local', 'share', 'pnpm'),
    path.join(homedir(), 'Library', 'pnpm')
  ])
  for (const directory of directories) {
    const executable = path.join(directory, 'pnpm')
    if (isRegularFile(executable)) return executable
  }
  return undefined
}

/** Resolves the PATH-registered Windows pnpm `.CMD` shim to its pnpm.mjs entry. */
export function resolveWindowsPnpmLauncher(
  directories: readonly string[] = windowsCommandDirectories()
): PnpmLauncher {
  for (const directory of directories) {
    const native = path.join(directory, 'pnpm.exe')
    if (isRegularFile(native)) {
      return {
        executable: native,
        prefixArguments: [],
        commandSearchPath: directories.join(path.delimiter)
      }
    }
    const shim = path.join(directory, 'pnpm.cmd')
    if (!isRegularFile(shim)) continue
    const scriptPath = readWindowsShimScript(shim)
    const node = [
      path.join(path.dirname(realpathSync(shim)), 'node.exe'),
      ...directories.map((entry) => path.join(entry, 'node.exe'))
    ].find(isRegularFile)
    if (scriptPath !== undefined && node !== undefined) {
      return {
        executable: node,
        prefixArguments: [scriptPath],
        commandSearchPath: [path.dirname(node), ...directories].join(path.delimiter)
      }
    }
  }
  return {
    executable: '',
    prefixArguments: [],
    commandSearchPath: directories.join(path.delimiter),
    resolutionError:
      'No runnable pnpm installation was found. Check Node.js and pnpm installation and restart Launcher.'
  }
}

/**
 * Builds a deterministic command PATH for pnpm's own shebang and its child tools.
 *
 * Finder does not inherit an interactive shell's PATH. Putting the resolved pnpm
 * directory first makes `/usr/bin/env node` find the matching package-manager
 * Node installation, then retains inherited and standard package-manager paths
 * for pnpm child commands.
 */
function buildCommandSearchPath(pnpmExecutable: string | undefined): string {
  return [
    ...(pnpmExecutable === undefined ? [] : [path.dirname(pnpmExecutable)]),
    ...splitPath(process.env.PATH),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(homedir(), '.local', 'share', 'pnpm'),
    path.join(homedir(), 'Library', 'pnpm'),
    '/usr/bin',
    '/bin'
  ]
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index)
    .join(path.delimiter)
}

/** Reads the actual npm/Corepack shim target without executing a command shell. */
function readWindowsShimScript(shim: string): string | undefined {
  const canonical = realpathSync(shim)
  const text = readFileSync(canonical, 'utf8')
  const match = /%(?:dp0|~dp0)%?[\\/]([^"\r\n]*pnpm\.(?:mjs|cjs|js))/iu.exec(text)
  if (match === null) return undefined
  const script = path.resolve(path.dirname(canonical), match[1]!.replace(/\\/gu, path.sep))
  return isRegularFile(script) ? script : undefined
}

/** Preserves PATH order and checks explicit package-manager installation locations. */
function windowsCommandDirectories(): string[] {
  const candidates = [
    ...splitPath(process.env.PATH),
    process.env.PNPM_HOME,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm'),
    path.join(homedir(), 'scoop', 'apps', 'nodejs', 'current'),
    path.join(homedir(), 'scoop', 'apps', 'nodejs', 'current', 'bin'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs')
  ]
  return [
    ...new Set(
      candidates
        .filter((entry): entry is string => Boolean(entry))
        .map((entry) => entry.replace(/^"|"$/gu, ''))
    )
  ]
}

/** Splits the platform's command search path, ignoring blank entries. */
function splitPath(pathValue: string | undefined): readonly string[] {
  return (pathValue ?? '').split(path.delimiter).filter((entry) => entry.length > 0)
}

/** Confirms a candidate is a regular file or a symlink resolving to one. */
function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}
