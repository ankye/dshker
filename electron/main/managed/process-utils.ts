import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'

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
  options: SpawnOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, arguments_, {
        ...options,
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
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(stdout)
        return
      }
      reject(new Error(stderr.slice(-4096)))
    })
  })
}
