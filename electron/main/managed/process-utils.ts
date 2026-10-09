import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import nodePath from 'node:path'

/** Extra execution controls for a shell-free text command. */
export interface RunTextOptions extends SpawnOptions {
  /** Reject and let the caller terminate the command when it exceeds this interval. */
  readonly timeoutMilliseconds?: number
  /** Receives the spawned process id when {@link timeoutMilliseconds} expires. */
  readonly onTimeout?: (processId: number | undefined) => void
  /**
   * Receives each stdout and stderr fragment as it arrives.
   *
   * Result collection is unchanged: the promise still resolves with complete
   * stdout and rejects with stderr. Callers use this to mirror long-running
   * commands (pnpm install, git fetch) into the visible console while they run.
   */
  readonly onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}

/** Identifies a command that exceeded the caller-owned operation limit. */
export class RunTextTimeoutError extends Error {
  constructor(timeoutMilliseconds: number) {
    super(`Command timed out after ${timeoutMilliseconds} ms.`)
    this.name = 'RunTextTimeoutError'
  }
}

/** Proves a path is a directly-owned directory rather than a symlink. */
export async function assertDirectDirectory(directory: string): Promise<void> {
  const metadata = await assertPathHasNoSymbolicLinkComponents(directory)
  if (!metadata.isDirectory()) {
    throw new Error('A direct directory is required.')
  }
}

/** Proves a path is a directly-owned regular file rather than a symlink. */
export async function assertDirectRegularFile(filePath: string): Promise<void> {
  const metadata = await assertPathHasNoSymbolicLinkComponents(filePath)
  if (!metadata.isFile()) {
    throw new Error('A direct regular file is required.')
  }
}

/**
 * Validates each lexical component rather than comparing realpath text.
 * Filesystems may return a different spelling for the same direct path (for
 * example a Windows 8.3 alias); symlink and junction components remain refused.
 */
async function assertPathHasNoSymbolicLinkComponents(targetPath: string) {
  if (!nodePath.isAbsolute(targetPath) || nodePath.resolve(targetPath) !== targetPath) {
    throw new Error('A normalized absolute path is required.')
  }

  const { root } = nodePath.parse(targetPath)
  const components = targetPath.slice(root.length).split(nodePath.sep).filter(Boolean)
  let currentPath = root
  let metadata = await lstat(currentPath)
  if (metadata.isSymbolicLink()) throw new Error('Symbolic-link paths are not allowed.')

  for (const [index, component] of components.entries()) {
    currentPath = nodePath.join(currentPath, component)
    metadata = await lstat(currentPath)
    if (metadata.isSymbolicLink()) throw new Error('Symbolic-link paths are not allowed.')
    if (index < components.length - 1 && !metadata.isDirectory()) {
      throw new Error('Every parent path component must be a direct directory.')
    }
  }

  return metadata
}

/** Runs one shell-free process and resolves only with its complete standard output. */
export function runText(
  executable: string,
  arguments_: readonly string[],
  options: RunTextOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { timeoutMilliseconds, onTimeout, onOutput, ...spawnOptions } = options
    let child: ChildProcess
    try {
      child = spawn(executable, arguments_, {
        ...spawnOptions,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let timeout: NodeJS.Timeout | undefined
    const clearTimeoutIfScheduled = (): void => {
      if (timeout !== undefined) clearTimeout(timeout)
    }
    child.stdout?.on('data', (chunk: unknown) => {
      const text = String(chunk)
      stdout += text
      onOutput?.('stdout', text)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      const text = String(chunk)
      stderr += text
      onOutput?.('stderr', text)
    })
    child.once('error', (error) => {
      clearTimeoutIfScheduled()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeoutIfScheduled()
      if (code === 0 && signal === null) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.slice(-4096)))
    })
    if (timeoutMilliseconds !== undefined) {
      timeout = setTimeout(() => {
        try {
          onTimeout?.(child.pid)
        } catch (error) {
          reject(error)
          return
        }
        reject(new RunTextTimeoutError(timeoutMilliseconds))
      }, timeoutMilliseconds)
    }
  })
}
