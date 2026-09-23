import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
    // A shim whose link cannot be resolved must not end the search.
    //
    // This used to call realpathSync directly: a scoop-style shim behind a
    // junction that the current session cannot resolve threw out of the whole
    // resolver, so every later candidate — including a working pnpm.exe — was
    // never examined and the launcher reported no runnable pnpm at all. The
    // throw surfaced much later as a refused DSH launch, which is why it read
    // as "cannot reach the coordinator" rather than as a missing pnpm.
    const shimDirectory = canonicalDirectory(shim)
    const node = [
      ...(shimDirectory === undefined ? [] : [path.join(shimDirectory, 'node.exe')]),
      path.join(path.dirname(shim), 'node.exe'),
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
    // Name where it looked. "No runnable pnpm was found" with no list left the
    // user and the maintainer with the same question and no way to answer it.
    resolutionError: `No runnable pnpm installation was found in: ${directories.join(', ')}. Check Node.js and pnpm installation and restart Launcher.`
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

/** Resolves a path's real directory, or undefined when the link cannot be followed. */
function canonicalDirectory(filePath: string): string | undefined {
  try {
    return path.dirname(realpathSync(filePath))
  } catch {
    return undefined
  }
}

/** Reads the actual npm/Corepack shim target without executing a command shell. */
function readWindowsShimScript(shim: string): string | undefined {
  let canonical: string
  let text: string
  try {
    canonical = realpathSync(shim)
    text = readFileSync(canonical, 'utf8')
  } catch {
    // Unreadable or unresolvable: the caller moves on to the next candidate
    // rather than the whole resolution failing on one bad entry.
    return undefined
  }
  const match = /%(?:dp0|~dp0)%?[\\/]([^"\r\n]*pnpm\.(?:mjs|cjs|js))/iu.exec(text)
  if (match === null) return undefined
  const script = path.resolve(path.dirname(canonical), match[1]!.replace(/\\/gu, path.sep))
  return isRegularFile(script) ? script : undefined
}

/**
 * Reads the PATH the user and machine have registered.
 *
 * A desktop-launched Electron app inherits whatever Explorer was started with,
 * which is a snapshot that predates any installer run since that sign-in. A
 * machine with a working `pnpm` in every terminal therefore had none as far as
 * this process was concerned. The registered value is the durable one, so it is
 * consulted in addition to the inherited PATH rather than instead of it.
 */
function registeredWindowsPath(): readonly string[] {
  try {
    const script =
      '[Environment]::GetEnvironmentVariable("PATH","User") + ";" + ' +
      '[Environment]::GetEnvironmentVariable("PATH","Machine")'
    const value = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    )
    return splitPath(value.trim())
  } catch {
    // An unavailable shell is not a failure: the inherited PATH and the explicit
    // locations below still apply.
    return []
  }
}

/** Preserves PATH order and checks explicit package-manager installation locations. */
function windowsCommandDirectories(): string[] {
  const candidates = [
    ...splitPath(process.env.PATH),
    ...registeredWindowsPath(),
    process.env.PNPM_HOME,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm'),
    path.join(homedir(), 'scoop', 'apps', 'nodejs', 'current'),
    path.join(homedir(), 'scoop', 'apps', 'nodejs', 'current', 'bin'),
    // Scoop keeps a package's writable files under persist/ and exposes them
    // through a junction, so a globally installed pnpm lives here rather than in
    // the versioned app directory. Only the junction was searched, and it does
    // not hold pnpm: a machine with a working `pnpm` on an interactive shell
    // still reported none, because a desktop-launched app does not inherit that
    // shell's PATH either. Searching the real location is what closes that gap.
    path.join(homedir(), 'scoop', 'persist', 'nodejs', 'bin'),
    path.join(homedir(), 'scoop', 'shims'),
    // Scoop exposes the selected Node through a `current` junction, and a
    // desktop-launched process cannot always follow it — the junction then
    // contributes nothing and node.exe appears to be missing. Naming the version
    // directories directly reaches the same files without the link, which is what
    // lets a resolved pnpm shim find the Node it needs to run.
    ...versionDirectories(path.join(homedir(), 'scoop', 'apps', 'nodejs')),
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

/** Lists an installation root's concrete version directories, newest names last. */
function versionDirectories(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'current')
      .flatMap((entry) => [path.join(root, entry.name), path.join(root, entry.name, 'bin')])
  } catch {
    return []
  }
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
