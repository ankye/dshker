import { GitRuntimeError } from './errors'
import type { GitCommitSha, GitRevisionSelection } from './types'

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

/** Creates a branch selection only from a portable, unambiguous branch name. */
