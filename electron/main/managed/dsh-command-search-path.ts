import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import nodePath from 'node:path'
import { ManagedHarnessRuntimeError } from './runtime-errors'

const LOGIN_SHELL_TIMEOUT_MILLISECONDS = 8_000
const LOGIN_SHELL_MAX_BUFFER_BYTES = 256 * 1024

type PosixLoginShell = 'bash' | 'zsh' | 'fish' | 'sh' | 'dash'

interface LoginShellInvocation {
  readonly shell: PosixLoginShell
  readonly argv0: string
  readonly arguments: readonly string[]
}

interface LoginShellExecution {
  readonly argv0: string
  readonly timeoutMilliseconds: number
  readonly maxBufferBytes: number
}

type LoginShellExecutor = (
  executable: string,
  arguments_: readonly string[],
  options: LoginShellExecution
) => Promise<string>

export interface ManagedDshCommandSearchPathOptions {
  readonly platform: NodeJS.Platform
  readonly environment: NodeJS.ProcessEnv
  readonly bundledRuntimeBin?: string
  /** Internal execution seam; the renderer cannot supply or invoke a shell. */
  readonly executeLoginShell?: LoginShellExecutor
}

/** Resolves and memoizes a successful DSH-only command search path. */
export function createManagedDshCommandSearchPathResolver(
  options: ManagedDshCommandSearchPathOptions
): () => Promise<string> {
  const delimiter = pathDelimiter(options.platform)
  const executeLoginShell = options.executeLoginShell ?? runLoginShell
  let resolved: string | undefined
  let pending: Promise<string> | undefined

  return async (): Promise<string> => {
    if (resolved !== undefined) return resolved
    if (pending !== undefined) return pending

    const resolution = (async (): Promise<string> => {
      const inheritedPath = readInheritedPath(options.environment, options.platform)
      if (
        options.platform === 'win32' &&
        (inheritedPath === undefined || inheritedPath.length === 0)
      ) {
        throw pathResolutionError(options.platform, 'The inherited Windows PATH is unavailable.')
      }
      const baseEntries = [
        ...(options.bundledRuntimeBin === undefined ? [] : [options.bundledRuntimeBin]),
        ...splitPath(inheritedPath, delimiter, 'inherited', options.platform)
      ]
      const shellEntries =
        options.platform === 'win32'
          ? []
          : await resolveLoginShellPath(
              options.environment.SHELL,
              delimiter,
              options.platform,
              executeLoginShell
            )
      const entries = deduplicatePathEntries(
        [...baseEntries, ...shellEntries],
        options.platform === 'win32'
      )
      if (entries.length === 0) {
        throw pathResolutionError(options.platform, 'The inherited command PATH is empty.')
      }
      return entries.join(delimiter)
    })()

    pending = resolution
    try {
      resolved = await resolution
      return resolved
    } catch (error) {
      if (error instanceof ManagedHarnessRuntimeError) throw error
      throw pathResolutionError(options.platform, 'The command PATH could not be resolved.')
    } finally {
      pending = undefined
    }
  }
}

/** Reads one PATH variable, treating Windows environment names case-insensitively. */
export function readInheritedPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined {
  const matchingEntries = Object.entries(environment).filter(([key]) =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  )
  const distinctValues = [...new Set(matchingEntries.map(([, value]) => value ?? ''))]
  if (distinctValues.length > 1) {
    throw pathResolutionError(platform, 'The inherited PATH variables conflict.')
  }
  return distinctValues[0]
}

/** Parses a single nonce-marked PATH payload, ignoring unrelated shell startup output. */
export function parseLoginShellPath(
  output: string,
  marker: string,
  delimiter: string,
  platform: NodeJS.Platform = process.platform
): string {
  const begin = `__DSHKER_PATH_BEGIN_${marker}__`
  const end = `__DSHKER_PATH_END_${marker}__`
  const beginIndex = output.indexOf(begin)
  const endIndex = output.indexOf(end)
  if (
    beginIndex < 0 ||
    endIndex <= beginIndex + begin.length ||
    beginIndex !== output.lastIndexOf(begin) ||
    endIndex !== output.lastIndexOf(end)
  ) {
    throw pathResolutionError(platform, 'The login shell returned an invalid PATH.')
  }

  const value = output.slice(beginIndex + begin.length, endIndex)
  if (value.length === 0 || value.includes('\0')) {
    throw pathResolutionError(platform, 'The login shell returned an invalid PATH.')
  }
  return splitPath(value, delimiter, 'login shell', platform).join(delimiter)
}

/** Returns the fixed login-interactive invocation supported for one configured POSIX shell. */
export function loginShellInvocation(
  shellPath: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): LoginShellInvocation {
  if (!nodePath.posix.isAbsolute(shellPath)) {
    throw pathResolutionError(platform, 'The configured login shell path is not absolute.')
  }
  const shellName = nodePath.posix.basename(shellPath).toLowerCase()
  if (
    shellName !== 'bash' &&
    shellName !== 'zsh' &&
    shellName !== 'fish' &&
    shellName !== 'sh' &&
    shellName !== 'dash'
  ) {
    throw pathResolutionError(platform, 'The configured login shell is unsupported.')
  }

  const usesArgv0ForLogin = shellName === 'sh' || shellName === 'dash'
  return {
    shell: shellName,
    argv0: `-${shellName}`,
    arguments: [...(usesArgv0ForLogin ? [] : ['-l']), '-i', '-c', command]
  }
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function splitPath(
  value: string | undefined,
  delimiter: string,
  source: string,
  platform: NodeJS.Platform
): string[] {
  if (value === undefined || value.length === 0) return []
  const entries = value.split(delimiter)
  // A single terminal semicolon is a conventional Windows PATH terminator,
  // not an empty search entry. Preserve the strict rejection for every other
  // empty entry so the current working directory is never added implicitly.
  if (platform === 'win32' && source === 'inherited' && entries.at(-1) === '') {
    entries.pop()
  }
  if (entries.some((entry) => entry.length === 0)) {
    throw pathResolutionError(platform, `The ${source} PATH contains an empty entry.`)
  }
  return entries
}

function deduplicatePathEntries(entries: readonly string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    const identity = caseInsensitive ? entry.toLowerCase() : entry
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(entry)
  }
  return result
}

async function resolveLoginShellPath(
  shellPath: string | undefined,
  delimiter: string,
  platform: NodeJS.Platform,
  execute: LoginShellExecutor
): Promise<string[]> {
  if (shellPath === undefined || shellPath.length === 0) {
    throw pathResolutionError(platform, 'The configured login shell is unavailable.')
  }

  const marker = randomUUID()
  const begin = `__DSHKER_PATH_BEGIN_${marker}__`
  const end = `__DSHKER_PATH_END_${marker}__`
  const isFish = nodePath.posix.basename(shellPath).toLowerCase() === 'fish'
  const command = isFish
    ? `printf '\\n%s%s%s\\n' '${begin}' (string join : $PATH) '${end}'`
    : `printf '\\n%s%s%s\\n' '${begin}' "$PATH" '${end}'`
  const invocation = loginShellInvocation(shellPath, command, platform)
  let output: string
  try {
    output = await execute(shellPath, invocation.arguments, {
      argv0: invocation.argv0,
      timeoutMilliseconds: LOGIN_SHELL_TIMEOUT_MILLISECONDS,
      maxBufferBytes: LOGIN_SHELL_MAX_BUFFER_BYTES
    })
  } catch (error) {
    const message = isTimeout(error)
      ? 'The configured login shell did not finish within 8 seconds.'
      : 'The configured login shell could not provide a command PATH.'
    throw pathResolutionError(platform, message)
  }

  const pathValue = parseLoginShellPath(output, marker, delimiter, platform)
  return pathValue.split(delimiter)
}

function runLoginShell(
  executable: string,
  arguments_: readonly string[],
  options: LoginShellExecution
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      argv0: options.argv0,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let output = ''
    let outputBytes = 0
    let settled = false
    const finish = (error: Error | undefined, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error !== undefined) reject(error)
      else resolve(value ?? '')
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(Object.assign(new Error('Login shell timed out.'), { code: 'ETIMEDOUT' }))
    }, options.timeoutMilliseconds)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8')
      if (outputBytes > options.maxBufferBytes) {
        child.kill()
        finish(
          Object.assign(new Error('Login shell output exceeded its limit.'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          })
        )
        return
      }
      output += chunk
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        finish(
          Object.assign(new Error('Login shell exited unsuccessfully.'), {
            code: code ?? signal ?? 'UNKNOWN'
          })
        )
        return
      }
      finish(undefined, output)
    })
  })
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ETIMEDOUT'
  )
}

function pathResolutionError(
  platform: NodeJS.Platform,
  message: string
): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError('runtime.spawn_failed', message, { platform })
}
