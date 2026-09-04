import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { GitRuntimeError, gitRuntimeFailure, type GitRuntimeErrorCode } from './errors'
import type {
  GitCommand,
  GitCommandResult,
  GitExecutableFingerprint,
  GitExecutableRegistration,
  GitExecutionContext,
  GitToolPolicy,
  GitVersion
} from './types'

const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND'
])

const REQUIRED_GIT_ENVIRONMENT = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
} as const

/** Explicitly allowed platform process variables needed for a direct Windows executable. */
const WINDOWS_ENVIRONMENT_NAMES = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])
const ALLOWED_ENVIRONMENT_NAMES = new Set([
  ...Object.keys(REQUIRED_GIT_ENVIRONMENT),
  'GIT_CONFIG_GLOBAL',
  ...WINDOWS_ENVIRONMENT_NAMES
])

/** A test seam for proving every production invocation remains shell-free. */
export type GitProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess

/** A direct, shell-free process runner for registered Git executables. */
export class GitCommandRunner {
  readonly #spawnProcess: GitProcessSpawner

  constructor(spawnProcess: GitProcessSpawner = directSpawn) {
    this.#spawnProcess = spawnProcess
  }

  /** Executes one Git command only after its pinned executable identity still matches. */
  async run(
    registration: GitExecutableRegistration,
    context: GitExecutionContext,
    command: GitCommand
  ): Promise<GitCommandResult> {
    await assertRegisteredGitExecutable(registration)
    return this.#runPinned(registration.canonicalPath, context, command)
  }

  /** Probes an executable during explicit registration before a version identity exists. */
  async probeVersion(absolutePath: string, context: GitExecutionContext): Promise<GitVersion> {
    const pinned = await pinGitExecutable(absolutePath)
    const result = await this.#runPinned(pinned.canonicalPath, context, {
      operation: 'git.version_probe',
      arguments: ['--version']
    })
    requireGitCommandSuccess(result)
    return parseGitVersion(result.stdout)
  }

  async #runPinned(
    executable: string,
    context: GitExecutionContext,
    command: GitCommand
  ): Promise<GitCommandResult> {
    assertGitExecutionContext(context)
    assertGitCommand(command)
    if (context.signal?.aborted) {
      throw new GitRuntimeError(
        'git.command_cancelled',
        'Git command was cancelled before it started.',
        {
          operation: command.operation
        }
      )
    }
    return runShellFreeProcess(this.#spawnProcess, executable, context, {
      ...command,
      arguments: deterministicGitArguments(command.arguments)
    })
  }
}

/** Registers one absolute Git executable and rejects an unsupported observed version. */
export async function registerGitExecutable(
  absolutePath: string,
  context: GitExecutionContext,
  policy: GitToolPolicy,
  runner = new GitCommandRunner()
): Promise<GitExecutableRegistration> {
  assertGitVersion(policy.minimumVersion, 'Git minimum version')
  assertGitVersion(policy.maximumExclusiveVersion, 'Git maximum version')
  if (compareGitVersions(policy.minimumVersion, policy.maximumExclusiveVersion) >= 0) {
    throw new GitRuntimeError('git.version_invalid', 'Git version policy range is invalid.')
  }
  const pinned = await pinGitExecutable(absolutePath)
  const version = await runner.probeVersion(absolutePath, context)
  await assertPinnedGitExecutable(pinned)
  if (compareGitVersions(version, policy.minimumVersion) < 0) {
    throw new GitRuntimeError(
      'git.version_unsupported',
      'Registered Git version is below the required minimum.',
      {
        observed: version.text,
        required: policy.minimumVersion.text
      }
    )
  }
  if (compareGitVersions(version, policy.maximumExclusiveVersion) >= 0) {
    throw new GitRuntimeError(
      'git.version_unsupported',
      'Registered Git version is above the required maximum.',
      {
        observed: version.text,
        required: `<${policy.maximumExclusiveVersion.text}`
      }
    )
  }
  return { ...pinned, version }
}

/** Builds the only baseline environment accepted for direct Git execution. */
export function createGitExecutionEnvironment(
  options: Readonly<{
    platform: NodeJS.Platform
    systemRoot?: string
    windir?: string
    comspec?: string
    pathExt?: string
  }>
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    ...REQUIRED_GIT_ENVIRONMENT,
    GIT_CONFIG_GLOBAL: options.platform === 'win32' ? 'NUL' : '/dev/null'
  }
  if (options.platform === 'win32') {
    if (!options.systemRoot || !options.windir || !options.comspec || !options.pathExt) {
      throw new GitRuntimeError(
        'git.command_invalid',
        'Windows Git execution requires explicitly registered Windows process variables.'
      )
    }
    environment.SYSTEMROOT = options.systemRoot
    environment.WINDIR = options.windir
    environment.COMSPEC = options.comspec
    environment.PATHEXT = options.pathExt
  }
  return environment
}

/** Rejects ambient home, search-path, Git configuration, and authentication inputs. */
export function assertGitExecutionContext(context: GitExecutionContext): void {
  assertCanonicalAbsolutePath(
    context.workingDirectory,
    'Git working directory',
    'git.command_invalid'
  )
  if (
    !Number.isSafeInteger(context.timeoutMilliseconds) ||
    context.timeoutMilliseconds < 1 ||
    context.timeoutMilliseconds > 300_000
  ) {
    throw new GitRuntimeError('git.command_invalid', 'Git command timeout is invalid.')
  }
  if (
    !Number.isSafeInteger(context.maximumOutputBytes) ||
    context.maximumOutputBytes < 1 ||
    context.maximumOutputBytes > 4 * 1024 * 1024
  ) {
    throw new GitRuntimeError('git.command_invalid', 'Git command output limit is invalid.')
  }

  const normalized = new Map<string, string>()
  for (const [name, value] of Object.entries(context.environment)) {
    const upperName = name.toUpperCase()
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== 'string' ||
      value.includes('\u0000')
    ) {
      throw new GitRuntimeError('git.command_invalid', 'Git command environment is invalid.')
    }
    if (normalized.has(upperName)) {
      throw new GitRuntimeError(
        'git.command_invalid',
        'Git command environment contains duplicate names.'
      )
    }
    normalized.set(upperName, value)
  }

  for (const [name, value] of Object.entries(REQUIRED_GIT_ENVIRONMENT)) {
    if (normalized.get(name) !== value) {
      throw new GitRuntimeError('git.command_invalid', `Git command environment must set ${name}.`)
    }
  }
  const globalConfig = normalized.get('GIT_CONFIG_GLOBAL')
  if (globalConfig !== '/dev/null' && globalConfig !== 'NUL') {
    throw new GitRuntimeError(
      'git.command_invalid',
      'Git command environment must disable global Git configuration.'
    )
  }

  for (const [name] of normalized) {
    if (!ALLOWED_ENVIRONMENT_NAMES.has(name)) {
      throw new GitRuntimeError(
        'git.command_invalid',
        'Git command environment contains an unapproved variable.',
        {
          variable: FORBIDDEN_ENVIRONMENT_NAMES.has(name) ? `${name} is forbidden` : name
        }
      )
    }
  }
}

/** Verifies that a registered executable still resolves to the same realpath and file identity. */
export async function assertRegisteredGitExecutable(
  registration: GitExecutableRegistration
): Promise<void> {
  await assertPinnedGitExecutable(registration)
}

async function assertPinnedGitExecutable(
  registration: Omit<GitExecutableRegistration, 'version'>
): Promise<void> {
  assertCanonicalAbsolutePath(
    registration.requestedPath,
    'Registered Git executable',
    'git.executable_invalid'
  )
  assertCanonicalAbsolutePath(
    registration.canonicalPath,
    'Registered Git executable',
    'git.executable_invalid'
  )
  let currentCanonicalPath: string
  let currentFingerprint: GitExecutableFingerprint
  try {
    currentCanonicalPath = await realpath(registration.requestedPath)
    currentFingerprint = await readExecutableFingerprint(currentCanonicalPath)
  } catch (error) {
    if (error instanceof GitRuntimeError) throw error
    throw gitRuntimeFailure(
      'git.executable_unavailable',
      'Registered Git executable is unavailable.',
      error
    )
  }
  if (
    currentCanonicalPath !== registration.canonicalPath ||
    !gitExecutableFingerprintsEqual(currentFingerprint, registration.fingerprint)
  ) {
    throw new GitRuntimeError(
      'git.executable_changed',
      'Registered Git executable changed after registration.'
    )
  }
}

/** Pins an explicitly selected executable with a canonical realpath and file fingerprint. */
export async function pinGitExecutable(
  absolutePath: string
): Promise<Omit<GitExecutableRegistration, 'version'>> {
  assertCanonicalAbsolutePath(absolutePath, 'Git executable', 'git.executable_invalid')
  let canonicalPath: string
  let fingerprint: GitExecutableFingerprint
  try {
    canonicalPath = await realpath(absolutePath)
    fingerprint = await readExecutableFingerprint(canonicalPath)
  } catch (error) {
    if (error instanceof GitRuntimeError) throw error
    throw gitRuntimeFailure(
      'git.executable_unavailable',
      'Git executable cannot be resolved.',
      error
    )
  }
  return { requestedPath: absolutePath, canonicalPath, fingerprint }
}

/** Parses the version line emitted by `git --version`. */
export function parseGitVersion(value: string): GitVersion {
  const match =
    /^git version (?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:[ .-][^\r\n]*)?\r?\n?$/.exec(
      value
    )
  if (!match?.groups) {
    throw new GitRuntimeError('git.version_invalid', 'Git version output is invalid.')
  }
  const major = Number(match.groups.major)
  const minor = Number(match.groups.minor)
  const patch = Number(match.groups.patch)
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new GitRuntimeError('git.version_invalid', 'Git version output is invalid.')
  }
  return { major, minor, patch, text: `${major}.${minor}.${patch}` }
}

/** Compares two parsed Git versions without accepting partial or prerelease strings. */
export function compareGitVersions(left: GitVersion, right: GitVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

/** Throws an actionable command error for an otherwise completed non-zero Git command. */
export function requireGitCommandSuccess(result: GitCommandResult): GitCommandResult {
  if (result.exitCode === 0) return result
  throw new GitRuntimeError('git.command_failed', 'Git command failed.', {
    operation: result.operation,
    executablePath: result.executablePath,
    workingDirectory: result.workingDirectory,
    environmentNames: result.environmentNames,
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr
  })
}

/** Redacts URL credentials and common authentication labels before output reaches diagnostics. */
export function redactGitOutput(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+(?::[^\s/@]*)?@)/gi, '$1[REDACTED]@')
    .replace(/(authorization\s*[=:]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:token|password)\s*[=:]\s*)[^\s\r\n]+/gi, '$1[REDACTED]')
}

function assertGitCommand(command: GitCommand): void {
  if (!/^[a-z][a-z0-9._-]{1,127}$/.test(command.operation)) {
    throw new GitRuntimeError('git.command_invalid', 'Git command operation identity is invalid.')
  }
  if (
    command.arguments.some(
      (argument) => typeof argument !== 'string' || argument.includes('\u0000')
    )
  ) {
    throw new GitRuntimeError('git.command_invalid', 'Git command arguments are invalid.')
  }
}

function deterministicGitArguments(arguments_: readonly string[]): readonly string[] {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return [
    '--no-pager',
    '-c',
    'credential.helper=',
    '-c',
    `core.hooksPath=${nullDevice}`,
    // Windows caps paths at 260 characters unless git uses its long-path file
    // APIs; a staging mirror path plus a pack file name already exceeds that.
    ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
    ...arguments_
  ]
}

async function runShellFreeProcess(
  spawnProcess: GitProcessSpawner,
  executable: string,
  context: GitExecutionContext,
  command: GitCommand
): Promise<GitCommandResult> {
  const startedAt = Date.now()
  return new Promise<GitCommandResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(executable, command.arguments, {
        cwd: context.workingDirectory,
        env: { ...context.environment },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(
        gitRuntimeFailure('git.executable_unavailable', 'Git executable could not start.', error, {
          operation: command.operation
        })
      )
      return
    }

    let stdout = ''
    let stderr = ''
    let receivedBytes = 0
    let termination: 'timeout' | 'cancelled' | 'output_limit' | undefined
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      context.signal?.removeEventListener('abort', abort)
    }
    const settleFailure = (error: GitRuntimeError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      termination = 'cancelled'
      child.kill()
    }
    const timeout = setTimeout(() => {
      termination = 'timeout'
      child.kill()
    }, context.timeoutMilliseconds)

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      receivedBytes += Buffer.byteLength(text)
      if (receivedBytes > context.maximumOutputBytes) {
        termination = 'output_limit'
        child.kill()
        return
      }
      if (target === 'stdout') stdout += text
      else stderr += text
    }

    if (!child.stdout || !child.stderr) {
      settleFailure(
        new GitRuntimeError('git.operation_failed', 'Git process did not expose captured output.')
      )
      return
    }
    child.stdout.on('data', (chunk: Buffer | string) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer | string) => capture('stderr', chunk))
    child.on('error', (error) => {
      settleFailure(
        gitRuntimeFailure('git.executable_unavailable', 'Git executable could not start.', error, {
          operation: command.operation
        })
      )
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (termination === 'timeout') {
        reject(
          new GitRuntimeError('git.command_timeout', 'Git command exceeded its declared timeout.', {
            operation: command.operation
          })
        )
        return
      }
      if (termination === 'cancelled') {
        reject(
          new GitRuntimeError('git.command_cancelled', 'Git command was cancelled.', {
            operation: command.operation
          })
        )
        return
      }
      if (termination === 'output_limit') {
        reject(
          new GitRuntimeError(
            'git.command_output_limit',
            'Git command exceeded its output limit.',
            { operation: command.operation }
          )
        )
        return
      }
      resolve({
        operation: command.operation,
        executablePath: executable,
        workingDirectory: context.workingDirectory,
        environmentNames: Object.keys(context.environment).sort(),
        arguments: command.arguments.map(redactGitOutput),
        exitCode,
        signal,
        stdout: redactGitOutput(stdout),
        stderr: redactGitOutput(stderr),
        elapsedMilliseconds: Date.now() - startedAt
      })
    })
    if (context.signal?.aborted) abort()
    else context.signal?.addEventListener('abort', abort, { once: true })
  })
}

function directSpawn(
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
): ChildProcess {
  return spawn(executable, [...arguments_], options)
}

async function readExecutableFingerprint(path: string): Promise<GitExecutableFingerprint> {
  const metadata = await stat(path)
  if (!metadata.isFile()) {
    throw new GitRuntimeError('git.executable_invalid', 'Git executable must be a regular file.')
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new GitRuntimeError('git.executable_invalid', 'Git executable is not executable.')
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMilliseconds: metadata.mtimeMs
  }
}

function gitExecutableFingerprintsEqual(
  left: GitExecutableFingerprint,
  right: GitExecutableFingerprint
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds
  )
}

function assertGitVersion(value: GitVersion, subject: string): void {
  if (
    !Number.isSafeInteger(value.major) ||
    !Number.isSafeInteger(value.minor) ||
    !Number.isSafeInteger(value.patch) ||
    value.major < 0 ||
    value.minor < 0 ||
    value.patch < 0 ||
    value.text !== `${value.major}.${value.minor}.${value.patch}`
  ) {
    throw new GitRuntimeError('git.version_invalid', `${subject} is invalid.`)
  }
}

function assertCanonicalAbsolutePath(
  value: unknown,
  subject: string,
  code: GitRuntimeErrorCode
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\u0000') ||
    !nodePath.isAbsolute(value)
  ) {
    throw new GitRuntimeError(code, `${subject} must be an absolute path.`)
  }
  if (nodePath.normalize(value) !== value || nodePath.parse(value).root === value) {
    throw new GitRuntimeError(code, `${subject} must be canonical and non-root.`)
  }
}
