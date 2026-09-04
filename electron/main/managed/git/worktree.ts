import { lstat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { requireSingleGitLine, runRequiredGitCommand } from './command'
import { GitRuntimeError, gitRuntimeFailure } from './errors'
import { inspectManagedGitMirror, verifyBareMirror } from './mirror'
import {
  acquireManagedGitOperationLock,
  assertManagedGitTarget,
  isSameRegisteredPath,
  managedWorktreePath
} from './paths'
import { assertGitRemoteIdentity, parseGitRemoteSource } from './remote'
import { parseGitCommitSha } from './revision'
import type { GitCommandRunner } from './process'
import type {
  GitCommitSha,
  GitExecutableRegistration,
  GitExecutionContext,
  GitNamedRemote,
  ManagedGitInstallationPaths,
  ManagedGitWorktree
} from './types'

/** Materializes a never-checked-out-before detached worktree for one exact resolved commit. */
export async function materializeManagedGitWorktree(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote,
  commit: GitCommitSha
): Promise<ManagedGitWorktree> {
  parseGitCommitSha(commit)
  const lock = await acquireManagedGitOperationLock(paths)
  try {
    await inspectManagedGitMirror(runner, registration, context, paths, remote)
    const target = managedWorktreePath(paths, commit)
    await assertWorktreeAbsent(target)
    await runRequiredGitCommand(runner, registration, context, {
      operation: 'git.materialize_detached_worktree',
      arguments: ['--git-dir', paths.mirrorPath, 'worktree', 'add', '--detach', target, commit]
    })
    return verifyManagedGitWorktree(runner, registration, context, paths, remote, commit)
  } finally {
    await lock.release()
  }
}

/** Re-reads every runtime-relevant worktree identity without changing its checkout state. */
export async function verifyManagedGitWorktree(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote,
  expectedCommit: GitCommitSha
): Promise<ManagedGitWorktree> {
  parseGitCommitSha(expectedCommit)
  await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
  await assertManagedGitTarget(
    paths,
    managedWorktreePath(paths, expectedCommit),
    'Managed Git worktree'
  )
  await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
  const worktreePath = managedWorktreePath(paths, expectedCommit)
  const [topLevel, head, commonDirectory, observedRemote] = await Promise.all([
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.read_worktree_top_level',
      arguments: ['-C', worktreePath, 'rev-parse', '--show-toplevel']
    }),
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.read_worktree_head',
      arguments: ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}']
    }),
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.read_worktree_common_directory',
      arguments: ['-C', worktreePath, 'rev-parse', '--git-common-dir']
    }),
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.read_worktree_remote',
      arguments: ['-C', worktreePath, 'remote', 'get-url', remote.name]
    })
  ])

  const observedTopLevel = requireSingleGitLine(topLevel.stdout, 'Managed worktree top-level')
  if (!isSameRegisteredPath(observedTopLevel, worktreePath)) {
    throw new GitRuntimeError(
      'git.worktree_mismatch',
      'Managed Git worktree top-level differs from its registered path.'
    )
  }
  const observedCommit = parseGitCommitSha(
    requireSingleGitLine(head.stdout, 'Managed worktree HEAD')
  )
  if (observedCommit !== expectedCommit) {
    throw new GitRuntimeError(
      'git.worktree_mismatch',
      'Managed Git worktree HEAD differs from the selected commit.',
      {
        expectedCommit,
        observedCommit
      }
    )
  }
  const commonDirectoryValue = requireSingleGitLine(
    commonDirectory.stdout,
    'Managed worktree common directory'
  )
  const commonDirectoryPath = nodePath.isAbsolute(commonDirectoryValue)
    ? commonDirectoryValue
    : nodePath.resolve(worktreePath, commonDirectoryValue)
  let canonicalCommonDirectory: string
  try {
    canonicalCommonDirectory = await realpath(commonDirectoryPath)
  } catch (error) {
    throw gitRuntimeFailure(
      'git.worktree_mismatch',
      'Managed Git worktree common directory is unavailable.',
      error
    )
  }
  if (!isSameRegisteredPath(canonicalCommonDirectory, paths.mirrorPath)) {
    throw new GitRuntimeError(
      'git.worktree_mismatch',
      'Managed Git worktree belongs to a different mirror.'
    )
  }
  const observedRemoteSource = parseGitRemoteSource(
    requireSingleGitLine(observedRemote.stdout, 'Managed worktree remote')
  )
  assertGitRemoteIdentity(remote.source.identity, observedRemoteSource.identity)
  await assertManagedGitWorktreeClean(runner, registration, context, worktreePath)
  return { path: worktreePath, commit: expectedCommit, remote }
}

/** Reads the complete porcelain status and refuses a worktree with any changed or untracked content. */
export async function assertManagedGitWorktreeClean(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  worktreePath: string
): Promise<void> {
  const result = await runRequiredGitCommand(runner, registration, context, {
    operation: 'git.inspect_worktree_cleanliness',
    arguments: [
      '-C',
      worktreePath,
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none'
    ]
  })
  const entries = result.stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length > 0) {
    throw new GitRuntimeError(
      'git.repository_dirty',
      'Managed Git worktree contains changes and cannot be activated.',
      {
        entryCount: entries.length,
        entries: entries.slice(0, 50)
      }
    )
  }
}

async function assertWorktreeAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return
    throw gitRuntimeFailure(
      'git.operation_failed',
      'Managed Git worktree path could not be inspected.',
      error
    )
  }
  throw new GitRuntimeError(
    'git.worktree_exists',
    'Managed Git worktree already exists for the selected commit.'
  )
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
