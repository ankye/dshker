import { lstat, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { requireSingleGitLine, runRequiredGitCommand } from './command'
import { GitRuntimeError, gitRuntimeFailure } from './errors'
import { assertGitNamedRemote, assertGitRemoteIdentity, parseGitRemoteSource } from './remote'
import { parseGitCommitSha } from './revision'
import type { GitCommandRunner } from './process'
import type {
  GitExecutableRegistration,
  GitExecutionContext,
  GitNamedRemote,
  UnmanagedGitRepositoryInspection
} from './types'

/** Inspects an explicitly selected user-owned checkout without a Git state-changing command. */
export async function inspectUnmanagedGitRepository(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  repositoryPath: string,
  expectedRemote: GitNamedRemote
): Promise<UnmanagedGitRepositoryInspection> {
  assertGitNamedRemote(expectedRemote)
  await assertExternalRepositoryPath(repositoryPath)
  const topLevelResult = await runner.run(registration, context, {
    operation: 'git.inspect_unmanaged_top_level',
    arguments: ['-C', repositoryPath, 'rev-parse', '--show-toplevel']
  })
  if (topLevelResult.exitCode !== 0) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Selected path is not an inspectable Git worktree.',
      {
        operation: topLevelResult.operation
      }
    )
  }
  const observedTopLevel = requireSingleGitLine(
    topLevelResult.stdout,
    'Unmanaged repository top-level'
  )
  if (observedTopLevel !== repositoryPath) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Selected path is not the Git worktree root.'
    )
  }
  const insideResult = await runRequiredGitCommand(runner, registration, context, {
    operation: 'git.inspect_unmanaged_inside_work_tree',
    arguments: ['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree']
  })
  if (requireSingleGitLine(insideResult.stdout, 'Unmanaged worktree state') !== 'true') {
    throw new GitRuntimeError('git.repository_invalid', 'Selected path is not a Git worktree.')
  }
  const [headResult, remoteResult, statusResult] = await Promise.all([
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.inspect_unmanaged_head',
      arguments: ['-C', repositoryPath, 'rev-parse', '--verify', 'HEAD^{commit}']
    }),
    runner.run(registration, context, {
      operation: 'git.inspect_unmanaged_remote',
      arguments: ['-C', repositoryPath, 'remote', 'get-url', expectedRemote.name]
    }),
    runRequiredGitCommand(runner, registration, context, {
      operation: 'git.inspect_unmanaged_status',
      arguments: [
        '-C',
        repositoryPath,
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ]
    })
  ])
  if (remoteResult.exitCode !== 0) {
    throw new GitRuntimeError(
      'git.remote_missing',
      'Selected repository does not expose the expected named remote.',
      {
        remote: expectedRemote.name
      }
    )
  }
  const observedRemote = parseGitRemoteSource(
    requireSingleGitLine(remoteResult.stdout, 'Unmanaged repository remote')
  )
  assertGitRemoteIdentity(expectedRemote.source.identity, observedRemote.identity)
  return {
    canonicalPath: repositoryPath,
    head: parseGitCommitSha(requireSingleGitLine(headResult.stdout, 'Unmanaged repository HEAD')),
    remote: observedRemote.identity,
    dirtyEntries: statusResult.stdout.split(/\r?\n/).filter(Boolean)
  }
}

async function assertExternalRepositoryPath(path: string): Promise<void> {
  if (typeof path !== 'string' || !path || path.includes('\u0000') || !nodePath.isAbsolute(path)) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Selected repository path must be absolute.'
    )
  }
  if (nodePath.normalize(path) !== path || nodePath.parse(path).root === path) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Selected repository path must be canonical and non-root.'
    )
  }
  let metadata
  let canonicalPath: string
  try {
    metadata = await lstat(path)
    canonicalPath = await realpath(path)
  } catch (error) {
    throw gitRuntimeFailure(
      'git.repository_invalid',
      'Selected repository path cannot be inspected.',
      error
    )
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonicalPath !== path) {
    throw new GitRuntimeError(
      'git.repository_invalid',
      'Selected repository path must be a canonical non-symbolic directory.'
    )
  }
}
