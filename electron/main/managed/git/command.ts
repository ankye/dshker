import { GitRuntimeError } from './errors'
import { requireGitCommandSuccess, type GitCommandRunner } from './process'
import type {
  GitCommand,
  GitCommandResult,
  GitExecutableRegistration,
  GitExecutionContext
} from './types'

/** Runs a named Git operation that must complete successfully. */
export async function runRequiredGitCommand(
  runner: GitCommandRunner,
  registration: GitExecutableRegistration,
  context: GitExecutionContext,
  command: GitCommand
): Promise<GitCommandResult> {
  return requireGitCommandSuccess(await runner.run(registration, context, command))
}

/** Extracts exactly one non-empty line from a Git protocol response. */
export function requireSingleGitLine(value: string, subject: string): string {
  const lines = value.split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) {
    throw new GitRuntimeError(
      'git.ref_ambiguous',
      `${subject} did not resolve to exactly one value.`
    )
  }
  return lines[0]
}

/** Reads a command failure that specifically means an unavailable ref. */
export function requireGitReferenceCommand(
  result: GitCommandResult,
  subject: string
): GitCommandResult {
  if (result.exitCode === 0) return result
  if (result.exitCode === 1 || result.exitCode === 128) {
    throw new GitRuntimeError(
      'git.ref_missing',
      `${subject} is unavailable in the fetched mirror.`,
      {
        operation: result.operation
      }
    )
  }
  return requireGitCommandSuccess(result)
}

/** Reads a command failure that specifically means a false ancestry predicate. */
export function isGitAncestryResult(result: GitCommandResult): boolean {
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  requireGitCommandSuccess(result)
  return false
}
