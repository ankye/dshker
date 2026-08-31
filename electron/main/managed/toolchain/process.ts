import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { ToolchainRuntimeError, toolchainRuntimeFailure } from './errors'
import {
  compareToolchainVersions,
  nodeVersionSatisfiesRange,
  parseNodeVersionOutput,
  parsePnpmVersionOutput
} from './semver'
import type {
  CheckoutToolchainRequirements,
  NodeExecutableRegistration,
  PnpmExecutableLauncher,
  PnpmExecutableRegistration,
  PnpmProbeContext,
  ToolchainExecutableFingerprint,
  ToolchainProbeResult,
  ToolchainProcessContext,
  ToolchainVersion
} from './types'

const MAX_TIMEOUT_MILLISECONDS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024
const WINDOWS_ENVIRONMENT_NAMES = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'])

/** The only file name accepted in an isolated pnpm probe directory. */
export const PNPM_PROBE_CONFIGURATION_FILE_NAME = 'pnpm-probe.npmrc'

/** A test seam for proving every production probe remains shell-free. */
export type ToolchainProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess

/** A direct shell-free runner for explicitly registered Node and pnpm entries. */
export class ToolchainCommandRunner {
  readonly #spawnProcess: ToolchainProcessSpawner

  constructor(spawnProcess: ToolchainProcessSpawner = directSpawn) {
    this.#spawnProcess = spawnProcess
  }

  /** Probes an already-pinned Node executable without consulting ambient process state. */
  async probeNodeVersion(
    canonicalPath: string,
    context: ToolchainProcessContext
  ): Promise<ToolchainVersion> {
    const result = await runShellFreeProbe(this.#spawnProcess, canonicalPath, context, {
      operation: 'node.version_probe',
      arguments: ['--version']
    })
    requireToolchainProbeSuccess(result)
    return parseNodeVersionOutput(result.stdout)
  }

  /** Probes an already-pinned pnpm entry through its explicitly declared launcher. */
  async probePnpmVersion(
    canonicalPath: string,
    launcher: PnpmExecutableLauncher,
    context: PnpmProbeContext
  ): Promise<ToolchainVersion> {
    const isolation = await resolvePnpmProbeIsolation(context)
    const probeArguments = [
      '--config-dir',
      isolation.directoryPath,
      '--dir',
      isolation.directoryPath,
      '--userconfig',
      isolation.configurationFilePath,
      '--globalconfig',
      isolation.configurationFilePath,
      '--ignore-workspace',
      '--version'
    ]
    const launch = resolvePnpmLaunch(canonicalPath, launcher, probeArguments)
    const result = await runShellFreeProbe(this.#spawnProcess, launch.executable, context, {
      operation: 'pnpm.version_probe',
      arguments: launch.arguments,
      workingDirectory: isolation.directoryPath
    })
    requireToolchainProbeSuccess(result)
    return parsePnpmVersionOutput(result.stdout)
  }
}

/** Builds the only baseline environment accepted for direct external-tool probes. */
export function createToolchainExecutionEnvironment(
  options: Readonly<{
    platform: NodeJS.Platform
    systemRoot?: string
    windir?: string
    comspec?: string
    pathExt?: string
  }>
): Readonly<Record<string, string>> {
  if (options.platform !== 'win32') return {}
  if (!options.systemRoot || !options.windir || !options.comspec || !options.pathExt) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_context_invalid',
      'Windows tool probes require explicitly registered Windows process variables.'
    )
  }
  return {
    SYSTEMROOT: options.systemRoot,
    WINDIR: options.windir,
    COMSPEC: options.comspec,
    PATHEXT: options.pathExt
  }
}

/** Registers one explicitly selected Node executable after a bounded direct version probe. */
export async function registerNodeExecutable(
  absolutePath: string,
  context: ToolchainProcessContext,
  runner = new ToolchainCommandRunner()
): Promise<NodeExecutableRegistration> {
  const pinned = await pinToolchainExecutable(absolutePath, 'Node executable', true)
  const version = await runner.probeNodeVersion(pinned.canonicalPath, context)
  await assertPinnedExecutable(pinned, 'Node executable', true)
  return { ...pinned, version }
}

/** Registers one explicitly selected pnpm entry after a bounded direct version probe. */
export async function registerPnpmExecutable(
  absolutePath: string,
  launcher: PnpmExecutableLauncher,
  context: PnpmProbeContext,
  runner = new ToolchainCommandRunner()
): Promise<PnpmExecutableRegistration> {
  assertPnpmLauncher(launcher)
  if (launcher.kind === 'node-script') await assertRegisteredNodeExecutable(launcher.node)
  const pinned = await pinToolchainExecutable(
    absolutePath,
    'pnpm executable',
    launcher.kind === 'native'
  )
  const version = await runner.probePnpmVersion(pinned.canonicalPath, launcher, context)
  await assertPinnedExecutable(pinned, 'pnpm executable', launcher.kind === 'native')
  if (launcher.kind === 'node-script') await assertRegisteredNodeExecutable(launcher.node)
  return { ...pinned, launcher, version }
}

/** Verifies a registered Node executable still resolves to its original file identity. */
export async function assertRegisteredNodeExecutable(
  registration: NodeExecutableRegistration
): Promise<void> {
  await assertPinnedExecutable(registration, 'Registered Node executable', true)
  assertToolchainVersion(registration.version, 'Registered Node version')
}

/** Verifies a registered pnpm entry and its declared Node launcher still match registration. */
export async function assertRegisteredPnpmExecutable(
  registration: PnpmExecutableRegistration
): Promise<void> {
  assertToolchainVersion(registration.version, 'Registered pnpm version')
  assertPnpmLauncher(registration.launcher)
  await assertPinnedExecutable(
    registration,
    'Registered pnpm executable',
    registration.launcher.kind === 'native'
  )
  if (registration.launcher.kind === 'node-script') {
    await assertRegisteredNodeExecutable(registration.launcher.node)
  }
}

/** Performs strict version and executable-identity admission for one selected checkout. */
export async function preflightCheckoutToolchain(
  requirements: CheckoutToolchainRequirements,
  node: NodeExecutableRegistration,
  pnpm: PnpmExecutableRegistration
): Promise<void> {
  await assertRegisteredNodeExecutable(node)
  await assertRegisteredPnpmExecutable(pnpm)
  if (!nodeVersionSatisfiesRange(node.version, requirements.nodeRange)) {
    throw new ToolchainRuntimeError(
      'toolchain.node_version_mismatch',
      'Registered Node version does not satisfy selected checkout engines.node.',
      { observed: node.version.text, required: requirements.nodeRange.text }
    )
  }
  if (compareToolchainVersions(pnpm.version, requirements.pnpm.version) !== 0) {
    throw new ToolchainRuntimeError(
      'toolchain.pnpm_version_mismatch',
      'Registered pnpm version does not match selected checkout packageManager.',
      { observed: pnpm.version.text, required: requirements.pnpm.text }
    )
  }
  if (pnpm.launcher.kind === 'node-script' && !nodeRegistrationsEqual(node, pnpm.launcher.node)) {
    throw new ToolchainRuntimeError(
      'toolchain.executable_invalid',
      'Selected pnpm script must be launched by the selected registered Node executable.'
    )
  }
}

/** Rejects every ambient search-path, home, npm, pnpm, and Node option input. */
export function assertToolchainProcessContext(context: ToolchainProcessContext): void {
  assertCanonicalAbsolutePath(
    context.workingDirectory,
    'Tool probe working directory',
    'toolchain.probe_context_invalid'
  )
  if (
    !Number.isSafeInteger(context.timeoutMilliseconds) ||
    context.timeoutMilliseconds < 1 ||
    context.timeoutMilliseconds > MAX_TIMEOUT_MILLISECONDS
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_context_invalid',
      'Tool probe timeout is invalid.'
    )
  }
  if (
    !Number.isSafeInteger(context.maximumOutputBytes) ||
    context.maximumOutputBytes < 1 ||
    context.maximumOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_context_invalid',
      'Tool probe output limit is invalid.'
    )
  }

  const normalized = new Map<string, string>()
  for (const [name, value] of Object.entries(context.environment)) {
    const upperName = name.toUpperCase()
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== 'string' ||
      value.includes('\u0000') ||
      normalized.has(upperName)
    ) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_context_invalid',
        'Tool probe environment is invalid.'
      )
    }
    if (!WINDOWS_ENVIRONMENT_NAMES.has(upperName)) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_context_invalid',
        'Tool probe environment contains an unapproved variable.',
        { variable: upperName }
      )
    }
    normalized.set(upperName, value)
  }
  if (process.platform === 'win32') {
    for (const name of WINDOWS_ENVIRONMENT_NAMES) {
      if (!normalized.has(name)) {
        throw new ToolchainRuntimeError(
          'toolchain.probe_context_invalid',
          'Windows tool probe environment is incomplete.',
          { variable: name }
        )
      }
    }
  } else if (normalized.size > 0) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_context_invalid',
      'Non-Windows tool probe environment must be empty.'
    )
  }
}

/** Throws a typed failure when a completed probe did not return exit code zero. */
export function requireToolchainProbeSuccess(result: ToolchainProbeResult): ToolchainProbeResult {
  if (result.exitCode === 0) return result
  throw new ToolchainRuntimeError('toolchain.probe_failed', 'External tool version probe failed.', {
    operation: result.operation,
    exitCode: result.exitCode ?? -1
  })
}

async function resolvePnpmProbeIsolation(
  context: PnpmProbeContext
): Promise<Readonly<{ directoryPath: string; configurationFilePath: string }>> {
  assertToolchainProcessContext(context)
  assertCanonicalAbsolutePath(
    context.configurationFilePath,
    'pnpm probe configuration file',
    'toolchain.probe_isolation_invalid'
  )
  if (nodePath.basename(context.configurationFilePath) !== PNPM_PROBE_CONFIGURATION_FILE_NAME) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_isolation_invalid',
      'pnpm probe configuration file has an unsupported name.'
    )
  }
  const directoryPath = nodePath.dirname(context.configurationFilePath)
  let directoryEntries: readonly string[]
  try {
    const directoryMetadata = await lstat(directoryPath)
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_isolation_invalid',
        'pnpm probe configuration directory must be a canonical directory.'
      )
    }
    const canonicalDirectoryPath = await realpath(directoryPath)
    if (canonicalDirectoryPath !== directoryPath) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_isolation_invalid',
        'pnpm probe configuration directory changed while being inspected.'
      )
    }
    if (context.workingDirectory !== canonicalDirectoryPath) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_isolation_invalid',
        'pnpm probe working directory must equal its isolated configuration directory.'
      )
    }
    directoryEntries = (await readdir(directoryPath)).sort()
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.probe_isolation_invalid',
      'pnpm probe configuration directory is unavailable.',
      error
    )
  }
  if (directoryEntries.length !== 1 || directoryEntries[0] !== PNPM_PROBE_CONFIGURATION_FILE_NAME) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_isolation_invalid',
      'pnpm probe configuration directory must contain only its empty configuration file.'
    )
  }

  try {
    const metadata = await lstat(context.configurationFilePath)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== 0) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_isolation_invalid',
        'pnpm probe configuration file must be an empty regular file.'
      )
    }
    const canonicalConfigurationFilePath = await realpath(context.configurationFilePath)
    if (canonicalConfigurationFilePath !== context.configurationFilePath) {
      throw new ToolchainRuntimeError(
        'toolchain.probe_isolation_invalid',
        'pnpm probe configuration file changed while being inspected.'
      )
    }
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.probe_isolation_invalid',
      'pnpm probe configuration file is unavailable.',
      error
    )
  }
  return { directoryPath, configurationFilePath: context.configurationFilePath }
}

function resolvePnpmLaunch(
  pnpmCanonicalPath: string,
  launcher: PnpmExecutableLauncher,
  probeArguments: readonly string[]
): Readonly<{ executable: string; arguments: readonly string[] }> {
  assertPnpmLauncher(launcher)
  if (launcher.kind === 'native') {
    return { executable: pnpmCanonicalPath, arguments: probeArguments }
  }
  return {
    executable: launcher.node.canonicalPath,
    arguments: [pnpmCanonicalPath, ...probeArguments]
  }
}

function assertPnpmLauncher(launcher: PnpmExecutableLauncher): void {
  if (!launcher || typeof launcher !== 'object') {
    throw new ToolchainRuntimeError('toolchain.executable_invalid', 'pnpm launcher is invalid.')
  }
  if (launcher.kind === 'native') return
  if (launcher.kind === 'node-script') {
    if (!launcher.node || typeof launcher.node !== 'object') {
      throw new ToolchainRuntimeError(
        'toolchain.executable_invalid',
        'pnpm Node-script launcher is invalid.'
      )
    }
    return
  }
  throw new ToolchainRuntimeError('toolchain.executable_invalid', 'pnpm launcher kind is invalid.')
}

async function pinToolchainExecutable(
  absolutePath: string,
  subject: string,
  requireExecutableBit: boolean
): Promise<Omit<NodeExecutableRegistration, 'version'>> {
  assertCanonicalAbsolutePath(absolutePath, subject, 'toolchain.executable_path_invalid')
  let canonicalPath: string
  let fingerprint: ToolchainExecutableFingerprint
  try {
    canonicalPath = await realpath(absolutePath)
    fingerprint = await readExecutableFingerprint(canonicalPath, requireExecutableBit)
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.executable_unavailable',
      `${subject} is unavailable.`,
      error
    )
  }
  return { requestedPath: absolutePath, canonicalPath, fingerprint }
}

async function assertPinnedExecutable(
  registration: Omit<NodeExecutableRegistration, 'version'>,
  subject: string,
  requireExecutableBit: boolean
): Promise<void> {
  assertPinnedExecutableRegistration(registration, subject)
  assertCanonicalAbsolutePath(
    registration.requestedPath,
    subject,
    'toolchain.executable_path_invalid'
  )
  assertCanonicalAbsolutePath(
    registration.canonicalPath,
    subject,
    'toolchain.executable_path_invalid'
  )
  let canonicalPath: string
  let fingerprint: ToolchainExecutableFingerprint
  try {
    canonicalPath = await realpath(registration.requestedPath)
    fingerprint = await readExecutableFingerprint(canonicalPath, requireExecutableBit)
  } catch (error) {
    if (error instanceof ToolchainRuntimeError) throw error
    throw toolchainRuntimeFailure(
      'toolchain.executable_unavailable',
      `${subject} is unavailable.`,
      error
    )
  }
  if (
    canonicalPath !== registration.canonicalPath ||
    !toolchainExecutableFingerprintsEqual(fingerprint, registration.fingerprint)
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.executable_changed',
      `${subject} changed after registration.`
    )
  }
}

async function readExecutableFingerprint(
  path: string,
  requireExecutableBit: boolean
): Promise<ToolchainExecutableFingerprint> {
  const metadata = await stat(path)
  if (!metadata.isFile()) {
    throw new ToolchainRuntimeError(
      'toolchain.executable_invalid',
      'Registered tool must be a regular file.'
    )
  }
  if (requireExecutableBit && process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new ToolchainRuntimeError(
      'toolchain.executable_invalid',
      'Registered tool is not executable.'
    )
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    modifiedAtMilliseconds: metadata.mtimeMs,
    changedAtMilliseconds: metadata.ctimeMs
  }
}

function toolchainExecutableFingerprintsEqual(
  left: ToolchainExecutableFingerprint,
  right: ToolchainExecutableFingerprint
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtMilliseconds === right.modifiedAtMilliseconds &&
    left.changedAtMilliseconds === right.changedAtMilliseconds
  )
}

function nodeRegistrationsEqual(
  left: NodeExecutableRegistration,
  right: NodeExecutableRegistration
): boolean {
  return (
    left.requestedPath === right.requestedPath &&
    left.canonicalPath === right.canonicalPath &&
    compareToolchainVersions(left.version, right.version) === 0 &&
    toolchainExecutableFingerprintsEqual(left.fingerprint, right.fingerprint)
  )
}

function assertPinnedExecutableRegistration(
  value: Omit<NodeExecutableRegistration, 'version'>,
  subject: string
): void {
  if (!value || typeof value !== 'object') {
    throw new ToolchainRuntimeError('toolchain.executable_invalid', `${subject} is invalid.`)
  }
  assertCanonicalAbsolutePath(value.requestedPath, subject, 'toolchain.executable_path_invalid')
  assertCanonicalAbsolutePath(value.canonicalPath, subject, 'toolchain.executable_path_invalid')
  const fingerprint = value.fingerprint
  if (
    !fingerprint ||
    typeof fingerprint !== 'object' ||
    ![
      fingerprint.device,
      fingerprint.inode,
      fingerprint.mode,
      fingerprint.size,
      fingerprint.modifiedAtMilliseconds,
      fingerprint.changedAtMilliseconds
    ].every((component) => typeof component === 'number' && Number.isFinite(component))
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.executable_invalid',
      `${subject} fingerprint is invalid.`
    )
  }
}

function assertToolchainVersion(
  value: unknown,
  subject: string
): asserts value is ToolchainVersion {
  if (!value || typeof value !== 'object') {
    throw new ToolchainRuntimeError('toolchain.version_invalid', `${subject} is invalid.`)
  }
  const version = value as ToolchainVersion
  if (
    !Number.isSafeInteger(version.major) ||
    !Number.isSafeInteger(version.minor) ||
    !Number.isSafeInteger(version.patch) ||
    version.major < 0 ||
    version.minor < 0 ||
    version.patch < 0 ||
    version.text !== `${version.major}.${version.minor}.${version.patch}`
  ) {
    throw new ToolchainRuntimeError('toolchain.version_invalid', `${subject} is invalid.`)
  }
}

async function runShellFreeProbe(
  spawnProcess: ToolchainProcessSpawner,
  executable: string,
  context: ToolchainProcessContext,
  command: Readonly<{
    operation: ToolchainProbeResult['operation']
    arguments: readonly string[]
    workingDirectory?: string
  }>
): Promise<ToolchainProbeResult> {
  assertToolchainProcessContext(context)
  assertCanonicalAbsolutePath(
    executable,
    'Registered tool executable',
    'toolchain.executable_path_invalid'
  )
  if (
    command.arguments.some(
      (argument) => typeof argument !== 'string' || argument.includes('\u0000')
    )
  ) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_context_invalid',
      'Tool probe arguments are invalid.'
    )
  }
  const workingDirectory = command.workingDirectory ?? context.workingDirectory
  assertCanonicalAbsolutePath(
    workingDirectory,
    'Tool probe working directory',
    'toolchain.probe_context_invalid'
  )
  if (context.signal?.aborted) {
    throw new ToolchainRuntimeError(
      'toolchain.probe_cancelled',
      'Tool probe was cancelled before start.',
      {
        operation: command.operation
      }
    )
  }

  const startedAt = Date.now()
  return new Promise<ToolchainProbeResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(executable, command.arguments, {
        cwd: workingDirectory,
        env: { ...context.environment },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(
        toolchainRuntimeFailure(
          'toolchain.executable_unavailable',
          'Registered tool could not start.',
          error,
          { operation: command.operation }
        )
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
    const rejectOnce = (error: ToolchainRuntimeError): void => {
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
      rejectOnce(
        new ToolchainRuntimeError(
          'toolchain.probe_failed',
          'Tool probe did not expose captured output.',
          { operation: command.operation }
        )
      )
      return
    }
    child.stdout.on('data', (chunk: Buffer | string) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer | string) => capture('stderr', chunk))
    child.on('error', (error) => {
      rejectOnce(
        toolchainRuntimeFailure(
          'toolchain.executable_unavailable',
          'Registered tool could not start.',
          error,
          { operation: command.operation }
        )
      )
    })
    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (termination === 'timeout') {
        reject(
          new ToolchainRuntimeError(
            'toolchain.probe_timeout',
            'Tool probe exceeded its deadline.',
            {
              operation: command.operation
            }
          )
        )
        return
      }
      if (termination === 'cancelled') {
        reject(
          new ToolchainRuntimeError('toolchain.probe_cancelled', 'Tool probe was cancelled.', {
            operation: command.operation
          })
        )
        return
      }
      if (termination === 'output_limit') {
        reject(
          new ToolchainRuntimeError(
            'toolchain.probe_output_limit',
            'Tool probe exceeded its output limit.',
            { operation: command.operation }
          )
        )
        return
      }
      resolve({
        operation: command.operation,
        executablePath: executable,
        arguments: [...command.arguments],
        workingDirectory,
        environmentNames: Object.keys(context.environment).sort(),
        exitCode,
        signal,
        stdout,
        stderr,
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

function assertCanonicalAbsolutePath(
  value: unknown,
  subject: string,
  code:
    | 'toolchain.executable_path_invalid'
    | 'toolchain.probe_context_invalid'
    | 'toolchain.probe_isolation_invalid'
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\u0000') ||
    !nodePath.isAbsolute(value) ||
    nodePath.normalize(value) !== value ||
    nodePath.parse(value).root === value
  ) {
    throw new ToolchainRuntimeError(
      code,
      `${subject} must be an absolute, normalized, non-root path.`
    )
  }
}
