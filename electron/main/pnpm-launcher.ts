import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** The pnpm Node script a Windows `.CMD` shim forwards to. */
const PNPM_NODE_SCRIPT_RELATIVE_PATH = ['..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'] as const

/** A direct executable invocation suitable for Node's shell-free spawn. */
export interface PnpmLauncher {
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
function resolveWindowsPnpmLauncher(): PnpmLauncher {
  const scriptPath = findWindowsPnpmNodeScript()
  if (scriptPath === undefined) {
    return { executable: 'pnpm', prefixArguments: [], commandSearchPath: process.env.PATH ?? '' }
  }
  return {
    executable: 'node',
    prefixArguments: [scriptPath],
    commandSearchPath: process.env.PATH ?? ''
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

/** Finds the `pnpm.mjs` entry beside the PATH-registered Windows pnpm shim, if any. */
function findWindowsPnpmNodeScript(): string | undefined {
  const pathExtensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0)
  for (const directory of splitPath(process.env.PATH)) {
    for (const extension of pathExtensions) {
      const shim = path.join(directory, `pnpm${extension}`)
      if (!isRegularFile(shim)) continue
      const script = path.resolve(directory, ...PNPM_NODE_SCRIPT_RELATIVE_PATH)
      if (isRegularFile(script)) return script
    }
  }
  return undefined
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
