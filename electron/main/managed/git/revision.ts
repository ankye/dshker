import { GitRuntimeError } from './errors'
import { isGitAncestryResult, requireGitReferenceCommand, requireSingleGitLine } from './command'
import { verifyBareMirror } from './mirror'
import { assertManagedGitTarget } from './paths'
import { assertGitNamedRemote } from './remote'
import type { GitCommandRunner } from './process'
import type {
  GitCommitSha,
  GitExecutableRegistration,
  GitExecutionContext,
  GitNamedRemote,
  GitReferenceObservation,
  GitRevisionSelection,
  ManagedGitInstallationPaths,
  ResolvedGitRevision
} from './types'

/** Creates a branch selection only from a portable, unambiguous branch name. */
export function selectGitBranch(branch: string): GitRevisionSelection {
  assertGitReferenceShortName(branch, 'Branch')
  return { kind: 'branch', branch }
}

/** Creates a tag selection only from a portable, unambiguous tag name. */
export function selectGitTag(tag: string): GitRevisionSelection {
  assertGitReferenceShortName(tag, 'Tag')
  return { kind: 'tag', tag }
}

/** Creates an exact commit selection. Abbreviated object ids are intentionally rejected. */
export function selectGitCommit(commit: string): GitRevisionSelection {
  return { kind: 'commit', commit: parseGitCommitSha(commit) }
}

/** Resolves one explicit branch, tag, or commit against an already fetched managed mirror. */
export async function resolveGitRevision(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  remote: GitNamedRemote,
  selection: GitRevisionSelection
): Promise<ResolvedGitRevision> {
  assertGitRevisionSelection(selection)
  assertGitNamedRemote(remote)
  await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
  await verifyBareMirror(runner, registration, context, paths.mirrorPath, remote)
  if (selection.kind === 'branch') {
    const reference = `refs/remotes/${remote.name}/${selection.branch}`
    const commit = await resolveCommitExpression(
      runner,
      registration,
      context,
      paths.mirrorPath,
      `${reference}^{commit}`,
      'Branch'
    )
    return {
      selection,
      commit,
      observedReference: reference,
      observedObject: commit
    }
  }
  if (selection.kind === 'tag') {
    const reference = `refs/tags/${selection.tag}`
    const tagObject = await resolveObjectExpression(
      runner,
      registration,
      context,
      paths.mirrorPath,
      reference,
      'Tag'
    )
    const commit = await resolveCommitExpression(
      runner,
      registration,
      context,
      paths.mirrorPath,
      `${reference}^{commit}`,
      'Tag'
    )
    return {
      selection,
      commit,
      observedReference: reference,
      observedObject: tagObject,
      tagObject
    }
  }
  const commit = await resolveCommitExpression(
    runner,
    registration,
    context,
    paths.mirrorPath,
    `${selection.commit}^{commit}`,
    'Commit'
  )
  if (commit !== selection.commit) {
    throw new GitRuntimeError(
      'git.ref_not_commit',
      'Requested commit did not resolve to its exact identity.'
    )
  }
  return {
    selection,
    commit,
    observedReference: selection.commit,
    observedObject: commit
  }
}

/** Detects a branch non-fast-forward or a tag target change before any user-directed activation. */
export async function assertGitReferenceNotRewritten(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  paths: ManagedGitInstallationPaths,
  previous: GitReferenceObservation,
  current: ResolvedGitRevision
): Promise<void> {
  if (
    previous.selection.kind !== current.selection.kind ||
    !sameSelection(previous.selection, current.selection)
  ) {
    throw new GitRuntimeError(
      'git.ref_invalid',
      'Reference rewrite comparison requires the same selected reference.'
    )
  }
  await assertManagedGitTarget(paths, paths.mirrorPath, 'Managed Git mirror')
  if (current.selection.kind === 'tag') {
    if (previous.commit !== current.commit) {
      throw new GitRuntimeError(
        'git.ref_rewritten',
        'Tracked tag now resolves to a different commit.',
        {
          previousCommit: previous.commit,
          currentCommit: current.commit
        }
      )
    }
    return
  }
  const ancestry = await runner.run(registration, context, {
    operation: 'git.verify_branch_descends',
    arguments: [
      '--git-dir',
      paths.mirrorPath,
      'merge-base',
      '--is-ancestor',
      previous.commit,
      current.commit
    ]
  })
  if (!isGitAncestryResult(ancestry)) {
    throw new GitRuntimeError(
      'git.ref_rewritten',
      'Tracked branch no longer descends from its previous commit.',
      {
        previousCommit: previous.commit,
        currentCommit: current.commit
      }
    )
  }
}

/** Converts one resolved mutable ref into the persisted observation used by a later fetch. */
export function createGitReferenceObservation(
  resolved: ResolvedGitRevision
): GitReferenceObservation {
  if (resolved.selection.kind === 'commit') {
    throw new GitRuntimeError(
      'git.ref_invalid',
      'Exact commit selections cannot be rewritten references.'
    )
  }
  return {
    selection: resolved.selection,
    commit: resolved.commit,
    observedObject: resolved.observedObject
  }
}

/** Parses one full lowercase SHA with no short-id or revision-expression fallback. */
export function parseGitCommitSha(value: unknown): GitCommitSha {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitRuntimeError('git.ref_invalid', 'Git commit must be a full lowercase SHA.')
  }
  return value as GitCommitSha
}

/** Validates an externally constructed selection before it reaches Git. */
export function assertGitRevisionSelection(selection: GitRevisionSelection): void {
  if (!selection || typeof selection !== 'object') {
    throw new GitRuntimeError('git.ref_invalid', 'Git revision selection is invalid.')
  }
  if (selection.kind === 'branch') {
    assertGitReferenceShortName(selection.branch, 'Branch')
    return
  }
  if (selection.kind === 'tag') {
    assertGitReferenceShortName(selection.tag, 'Tag')
    return
  }
  if (selection.kind === 'commit') {
    parseGitCommitSha(selection.commit)
    return
  }
  throw new GitRuntimeError('git.ref_invalid', 'Git revision selection is invalid.')
}

function assertGitReferenceShortName(value: unknown, subject: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('refs/') ||
    value.startsWith('/') ||
    value.endsWith('/')
  ) {
    throw new GitRuntimeError('git.ref_invalid', `${subject} name is invalid.`)
  }
  if (/\s|[\u0000-\u001f~^:?*\\\[]|\.\.|@\{/.test(value) || value.includes('//')) {
    throw new GitRuntimeError('git.ref_invalid', `${subject} name is invalid.`)
  }
  const segments = value.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.lock') ||
        segment.endsWith('.')
    )
  ) {
    throw new GitRuntimeError('git.ref_invalid', `${subject} name is invalid.`)
  }
}

async function resolveObjectExpression(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  mirrorPath: string,
  expression: string,
  subject: string
): Promise<string> {
  const result = requireGitReferenceCommand(
    await runner.run(registration, context, {
      operation: 'git.resolve_reference_object',
      arguments: ['--git-dir', mirrorPath, 'rev-parse', '--verify', '--end-of-options', expression]
    }),
    subject
  )
  return parseGitCommitSha(requireSingleGitLine(result.stdout, `${subject} object`))
}

async function resolveCommitExpression(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  mirrorPath: string,
  expression: string,
  subject: string
): Promise<GitCommitSha> {
  const result = requireGitReferenceCommand(
    await runner.run(registration, context, {
      operation: 'git.resolve_reference_commit',
      arguments: ['--git-dir', mirrorPath, 'rev-parse', '--verify', '--end-of-options', expression]
    }),
    subject
  )
  return parseGitCommitSha(requireSingleGitLine(result.stdout, `${subject} commit`))
}

function sameSelection(left: GitRevisionSelection, right: GitRevisionSelection): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'branch' && right.kind === 'branch') return left.branch === right.branch
  if (left.kind === 'tag' && right.kind === 'tag') return left.tag === right.tag
  return left.kind === 'commit' && right.kind === 'commit' && left.commit === right.commit
}
