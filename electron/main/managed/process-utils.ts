import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'

/** Extra execution controls for a shell-free text command. */
export interface RunTextOptions extends SpawnOptions {
  /** Reject and let the caller terminate the command when it exceeds this interval. */
  readonly timeoutMilliseconds?: number
  /** Receives the spawned process id when {@link timeoutMilliseconds} expires. */
  readonly onTimeout?: (processId: number | undefined) => void
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
  const metadata = await lstat(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error('A direct directory is required.')
  }
}

/** Proves a path is a directly-owned regular file rather than a symlink. */
export async function assertDirectRegularFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile() || (await realpath(filePath)) !== filePath) {
    throw new Error('A direct regular file is required.')
  }
}

/** Runs one shell-free process and resolves only with its complete standard output. */
export function runText(
  executable: string,
  arguments_: readonly string[],
  options: RunTextOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { timeoutMilliseconds, onTimeout, ...spawnOptions } = options
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
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
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
