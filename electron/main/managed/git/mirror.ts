import { lstat, rename, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import nodePath from 'node:path'
import { requireSingleGitLine, runRequiredGitCommand } from './command'
import { GitRuntimeError, gitRuntimeFailure } from './errors'
import {
  acquireManagedGitOperationLock,
  assertManagedGitTarget,
  ensureManagedGitInstallationDirectories
} from './paths'
import {
  assertGitNamedRemote,
  assertGitRemoteIdentity,
  assertGitRemoteName,
  parseGitRemoteSource
} from './remote'
import { requireGitCommandSuccess, type GitCommandRunner } from './process'
import type {
  GitExecutableRegistration,
  GitExecutionContext,
  GitNamedRemote,
  ManagedGitInstallationPaths
} from './types'

/** Readback identity for a verified launcher-owned bare mirror. */
export interface ManagedGitMirror {
  readonly path: string
  readonly remote: GitNamedRemote
}

/** Creates a new bare mirror through a private staging path and one atomic publication rename. */
export async function createManagedGitMirror(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote
): Promise<ManagedGitMirror> {
  assertNamedRemoteIntegrity(remote)
  const lock = await acquireManagedGitOperationLock(paths)
  try {
    await ensureManagedGitInstallationDirectories(paths)
    await assertPathAbsent(
      paths.mirrorPath,
      'git.mirror_exists',
      'Managed Git mirror already exists.'
    )
    const stagingMirrorPath = nodePath.join(paths.stagingPath, `mirror-${randomUUID()}.git`)
    await assertPathAbsent(
      stagingMirrorPath,
      'git.operation_failed',
      'Managed Git staging mirror already exists.'
    )
    await assertSameFilesystem(
      paths.stagingPath,
      nodePath.dirname(paths.mirrorPath),
      paths.installationId
    )

    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.create_bare_mirror',
      arguments: ['init', '--bare', stagingMirrorPath]
    })
    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.add_mirror_remote',
      arguments: [
        '--git-dir',
        stagingMirrorPath,
        'remote',
        'add',
        remote.name,
        remote.source.declaredUrl
      ]
    })
    await fetchMirrorRemote(runner, registration, context, stagingMirrorPath, remote.name)
    await verifyBareMirror(runner, registration, context, stagingMirrorPath, remote)
    try {
      await rename(stagingMirrorPath, paths.mirrorPath)
    } catch (error) {
      throw gitRuntimeFailure(
        'git.operation_failed',
        'Managed Git mirror could not be published atomically.',
        error,
        {
          installationId: paths.installationId
        }
      )
    }
    await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
    await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
    return { path: paths.mirrorPath, remote }
  } finally {
    await lock.release()
  }
}

/**
 * Imports one previously verified bundle into a fresh managed mirror without persisting the bundle as a Git remote.
 *
 * Branches are written directly to the normal remote-tracking namespace so subsequent revision resolution is
 * identical to a mirror created from the declared network remote.
 */
export async function createManagedGitMirrorFromBundle(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote,
  bundlePath: string
): Promise<ManagedGitMirror> {
  assertNamedRemoteIntegrity(remote)
  await assertDirectRegularBundleFile(bundlePath)
  const lock = await acquireManagedGitOperationLock(paths)
  try {
    await ensureManagedGitInstallationDirectories(paths)
    await assertPathAbsent(
      paths.mirrorPath,
      'git.mirror_exists',
      'Managed Git mirror already exists.'
    )
    const stagingMirrorPath = nodePath.join(paths.stagingPath, `mirror-${randomUUID()}.git`)
    await assertPathAbsent(
      stagingMirrorPath,
      'git.operation_failed',
      'Managed Git staging mirror already exists.'
    )
    await assertSameFilesystem(
      paths.stagingPath,
      nodePath.dirname(paths.mirrorPath),
      paths.installationId
    )

    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.create_bare_mirror',
      arguments: ['init', '--bare', stagingMirrorPath]
    })
    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.import_bundle_objects',
      arguments: [
        '--git-dir',
        stagingMirrorPath,
        'fetch',
        '--atomic',
        '--no-write-fetch-head',
        '--no-tags',
        '--',
        bundlePath,
        `+refs/heads/*:refs/remotes/${remote.name}/*`,
        '+refs/tags/*:refs/tags/*'
      ]
    })
    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.add_mirror_remote',
      arguments: [
        '--git-dir',
        stagingMirrorPath,
        'remote',
        'add',
        remote.name,
        remote.source.declaredUrl
      ]
    })
    await verifyBareMirror(runner, registration, context, stagingMirrorPath, remote)
    try {
      await rename(stagingMirrorPath, paths.mirrorPath)
    } catch (error) {
      throw gitRuntimeFailure(
        'git.operation_failed',
        'Managed Git mirror could not be published atomically.',
        error,
        {
          installationId: paths.installationId
        }
      )
    }
    await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
    await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
    return { path: paths.mirrorPath, remote }
  } finally {
    await lock.release()
  }
}

/** Fetches only the declared remote into an existing verified launcher-owned mirror. */
export async function fetchManagedGitMirror(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote
): Promise<ManagedGitMirror> {
  assertNamedRemoteIntegrity(remote)
  const lock = await acquireManagedGitOperationLock(paths)
  try {
    await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
    await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
    await fetchMirrorRemote(runner, registration, context, paths.mirrorPath, remote.name)
    await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
    return { path: paths.mirrorPath, remote }
  } finally {
    await lock.release()
  }
}

/** Reads a managed mirror without fetch or configuration mutation. */
export async function inspectManagedGitMirror(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote
): Promise<ManagedGitMirror> {
  assertNamedRemoteIntegrity(remote)
  await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
  await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
  return { path: paths.mirrorPath, remote }
}

/** Verifies both bare-repository state and the single expected remote identity. */
export async function verifyBareMirror(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  mirrorPath: string,
  remote: GitNamedRemote
): Promise<void> {
  const bare = await runRequiredGitCommand(runner, registration, context, {
    operation: 'git.verify_bare_mirror',
    arguments: ['--git-dir', mirrorPath, 'rev-parse', '--is-bare-repository']
  })
  if (requireSingleGitLine(bare.stdout, 'Bare mirror state') !== 'true') {
    throw new GitRuntimeError(
      'git.repository_not_bare',
      'Managed Git mirror is not a bare repository.'
    )
  }
  const [remoteNames, remoteUrls, remotePushUrls] = await Promise.all([
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.read_mirror_remote_names',
      arguments: ['--git-dir', mirrorPath, 'remote']
    }),
    runner.run(registration, context, {
      operation: 'git.read_mirror_remote_url',
      arguments: [
        '--git-dir',
        mirrorPath,
        'config',
        '--local',
        '--get-all',
        `remote.${remote.name}.url`
      ]
    }),
    runner.run(registration, context, {
      operation: 'git.read_mirror_remote_push_url',
      arguments: [
        '--git-dir',
        mirrorPath,
        'config',
        '--local',
        '--get-all',
        `remote.${remote.name}.pushurl`
      ]
    })
  ])
  const names = remoteNames.stdout.split(/\r?\n/).filter(Boolean)
  if (names.length !== 1 || names[0] !== remote.name) {
    throw new GitRuntimeError(
      'git.remote_mismatch',
      'Managed Git mirror contains unexpected named remotes.'
    )
  }
  if (remoteUrls.exitCode !== 0) {
    throw new GitRuntimeError(
      'git.remote_missing',
      'Managed Git mirror does not contain the selected remote.'
    )
  }
  const urls = remoteUrls.stdout.split(/\r?\n/).filter(Boolean)
  if (urls.length !== 1) {
    throw new GitRuntimeError(
      'git.remote_mismatch',
      'Managed Git mirror has an ambiguous remote URL.'
    )
  }
  if (remotePushUrls.exitCode === 0 && remotePushUrls.stdout.trim()) {
    throw new GitRuntimeError(
      'git.remote_mismatch',
      'Managed Git mirror must not configure a push-only remote URL.'
    )
  }
  if (remotePushUrls.exitCode !== 0 && remotePushUrls.exitCode !== 1) {
    requireGitCommandSuccess(remotePushUrls)
  }
  await assertNoMirrorConfigurationRewrite(runner, registration, context, mirrorPath)
  const observedUrl = urls[0]
  const observedSource = parseGitRemoteSource(observedUrl)
  assertGitRemoteIdentity(remote.source.identity, observedSource.identity)
}

async function fetchMirrorRemote(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  mirrorPath: string,
  remoteName: string
): Promise<void> {
  assertGitRemoteName(remoteName)
  await runRequiredGitCommand(runner, registration, context, {
    operation: 'git.fetch_managed_mirror',
    arguments: [
      '--git-dir',
      mirrorPath,
      'fetch',
      '--no-write-fetch-head',
      '--prune',
      '--prune-tags',
      remoteName,
      '+refs/heads/*:refs/remotes/' + remoteName + '/*',
      '+refs/tags/*:refs/tags/*'
    ]
  })
}

async function assertNoMirrorConfigurationRewrite(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  mirrorPath: string
): Promise<void> {
  for (const pattern of ['^url\\..*\\.insteadOf$', '^include\\.']) {
    const result = await runner.run(registration, context, {
      operation: 'git.inspect_mirror_rewrite_configuration',
      arguments: ['--git-dir', mirrorPath, 'config', '--local', '--get-regexp', pattern]
    })
    if (result.exitCode === 1) continue
    requireGitCommandSuccess(result)
    if (result.stdout.trim()) {
      throw new GitRuntimeError(
        'git.remote_invalid',
        'Managed Git mirror contains a local configuration rewrite or include.'
      )
    }
  }
}

function assertNamedRemoteIntegrity(remote: GitNamedRemote): void {
  assertGitNamedRemote(remote)
}

async function assertPathAbsent(
  path: string,
  code: 'git.mirror_exists' | 'git.operation_failed',
  message: string
): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    throw gitRuntimeFailure(
      'git.operation_failed',
      'Managed Git path could not be inspected.',
      error
    )
  }
  throw new GitRuntimeError(code, message)
}

async function assertDirectRegularBundleFile(bundlePath: string): Promise<void> {
  if (
    typeof bundlePath !== 'string' ||
    bundlePath.length === 0 ||
    bundlePath.includes('\u0000') ||
    !nodePath.isAbsolute(bundlePath) ||
    nodePath.normalize(bundlePath) !== bundlePath ||
    nodePath.parse(bundlePath).root === bundlePath
  ) {
    throw new GitRuntimeError('git.repository_invalid', 'Managed Git bundle path is invalid.')
  }
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(bundlePath)
  } catch (error) {
    throw gitRuntimeFailure('git.repository_invalid', 'Managed Git bundle is unavailable.', error)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Managed Git bundle must be a direct regular file.'
    )
  }
}

async function assertSameFilesystem(
  left: string,
  right: string,
  installationId: string
): Promise<void> {
  try {
    const [leftMetadata, rightMetadata] = await Promise.all([stat(left), stat(right)])
    if (leftMetadata.dev !== rightMetadata.dev) {
      throw new GitRuntimeError(
        'git.operation_failed',
        'Managed Git staging and mirror publication directories differ.',
        {
          installationId
        }
      )
    }
  } catch (error) {
    if (error instanceof GitRuntimeError) throw error
    throw gitRuntimeFailure(
      'git.operation_failed',
      'Managed Git publication directories could not be inspected.',
      error,
      {
        installationId
      }
    )
  }
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
