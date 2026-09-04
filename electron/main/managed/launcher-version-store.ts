import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import { launcherGitArguments } from './launcher-harness-commands'
import { readHarnessReadiness } from './launcher-harness-views'
import { runText } from './process-utils'

/** Persisted pointer format; a foreign document is a typed failure, not a reset. */
export const LAUNCHER_VERSION_POINTER_FORMAT = 'dsh-launcher-harness-current' as const

/** Writes the active-version pointer through a same-directory temporary rename. */
export async function writeCurrentVersionPointer(
  pointerPath: string,
  commit: string
): Promise<void> {
  assertCompleteCommit(commit)
  await mkdir(nodePath.dirname(pointerPath), { recursive: true })
  const stagingPath = `${pointerPath}.${process.pid}.tmp`
  await writeFile(
    stagingPath,
    `${JSON.stringify({ format: LAUNCHER_VERSION_POINTER_FORMAT, commit }, undefined, 2)}\n`,
    'utf8'
  )
  await rename(stagingPath, pointerPath)
}

/**
 * Reads the active commit, or undefined before the first version exists.
 *
 * A present-but-malformed pointer is a typed failure: guessing the active
 * version would silently run an unverified checkout.
 */
export async function readCurrentVersionPointer(pointerPath: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises')
  let text: string
  try {
    text = await readFile(pointerPath, 'utf8')
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return undefined
    throw error
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw malformedPointer()
  }
  const record = document as { format?: unknown; commit?: unknown }
  if (
    record?.format !== LAUNCHER_VERSION_POINTER_FORMAT ||
    typeof record.commit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(record.commit)
  ) {
    throw malformedPointer()
  }
  return record.commit
}

/** Resolves one version's directory; the commit names it, so it is validated. */
export function versionDirectory(versionsDirectory: string, commit: string): string {
  assertCompleteCommit(commit)
  return nodePath.join(versionsDirectory, commit)
}

/** Materializes one commit as a detached worktree of the main repository. */
export async function addLauncherVersionWorktree(
  gitExecutable: string,
  mainRepository: string,
  targetDirectory: string,
  commit: string
): Promise<void> {
  assertCompleteCommit(commit)
  await runText(
    gitExecutable,
    launcherGitArguments([
      '-C',
      mainRepository,
      'worktree',
      'add',
      '--detach',
      targetDirectory,
      commit
    ])
  )
}

/** Build actions the service owns; the store orchestrates, the service runs pnpm. */
export interface VersionMaterializationSteps {
  readonly loggedStep: <T>(description: string, step: () => Promise<T>) => Promise<T>
  readonly install: (directory: string) => Promise<void>
  readonly build: (directory: string) => Promise<void>
  readonly reconcilePlugins: (directory: string) => Promise<void>
  readonly event: (message: string) => void
}

/**
 * Builds one exact commit in its own directory and only then flips the
 * active-version pointer.
 *
 * Nothing touches the currently active version: a failed or interrupted
 * materialization leaves it untouched, and an interrupted deletion of the
 * replaced version is retried on the next switch. There is no in-place
 * `git clean`, so a switch can never brick the version the app is running.
 * Deletion of replaced versions runs off the critical path after the flip.
 */
export async function materializeLauncherVersion(
  gitExecutable: string,
  mainRepository: string,
  versionsDirectory: string,
  pointerPath: string,
  commit: string,
  steps: VersionMaterializationSteps
): Promise<void> {
  const target = versionDirectory(versionsDirectory, commit)
  const readiness = await readHarnessReadiness(target).catch(() => ({ kind: 'invalid' as const }))
  if (readiness.kind !== 'ready') {
    await steps.loggedStep(`Removing any interrupted preparation of commit ${commit}`, () =>
      removeVersionDirectory(target).then(() => undefined)
    )
    await steps.loggedStep('Verifying the selected commit is on origin/master', () =>
      runText(
        gitExecutable,
        launcherGitArguments([
          '-C',
          mainRepository,
          'merge-base',
          '--is-ancestor',
          commit,
          'origin/master'
        ])
      )
    )
    await steps.loggedStep(`Preparing a fresh worktree for DSH commit ${commit}`, () =>
      addLauncherVersionWorktree(gitExecutable, mainRepository, target, commit)
    )
    await steps.loggedStep('Installing DSH dependencies (pnpm install --frozen-lockfile)', () =>
      steps.install(target)
    )
    await steps.loggedStep('Building DSH (pnpm run build)', () => steps.build(target))
    await steps.loggedStep('Reconciling the DSH web profile plugins', () =>
      steps.reconcilePlugins(target)
    )
    const verified = await readHarnessReadiness(target)
    if (verified.kind !== 'ready') {
      throw new ManagedHarnessRuntimeError(
        'runtime.worktree_invalid',
        'The prepared DSH version did not finish building.'
      )
    }
  } else {
    steps.event(`DSH commit ${commit} is already prepared; switching to it directly.`)
  }
  await writeCurrentVersionPointer(pointerPath, commit)
}

/**
 * Removes every version directory except the kept one, plus stale worktree
 * registration. Deletion runs off the critical path after a pointer flip, so a
 * failure here is logged and retried on the next switch, never fatal.
 */
export async function pruneInactiveVersions(
  gitExecutable: string,
  mainRepository: string,
  versionsDirectory: string,
  keepCommit: string,
  log: (message: string) => void
): Promise<void> {
  const directories = await inactiveVersionDirectories(versionsDirectory, keepCommit)
  for (const directory of directories) {
    log(`Removing the previous DSH version directory ${nodePath.basename(directory)}.`)
    try {
      await removeVersionDirectory(directory)
    } catch (error) {
      log(
        `Previous version directory could not be removed fully and will be retried later: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      )
    }
  }
  await runText(
    gitExecutable,
    launcherGitArguments(['-C', mainRepository, 'worktree', 'prune'])
  ).catch(() => undefined)
}

/** Lists every materialized version directory except the one being kept. */
export async function inactiveVersionDirectories(
  versionsDirectory: string,
  keepCommit: string
): Promise<readonly string[]> {
  assertCompleteCommit(keepCommit)
  let entries: readonly string[]
  try {
    entries = await readdir(versionsDirectory)
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return []
    throw error
  }
  return entries
    .filter((entry) => /^[0-9a-f]{40}$/u.test(entry) && entry !== keepCommit)
    .map((entry) => nodePath.join(versionsDirectory, entry))
    .sort()
}

/** Removes one directory tree best-effort; interrupted removals are retried later. */
export async function removeVersionDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

function malformedPointer(): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError(
    'runtime.version_pointer_invalid',
    'The active DSH version record is malformed.'
  )
}

function assertCompleteCommit(commit: string): void {
  if (/^[0-9a-f]{40}$/u.test(commit)) return
  throw new ManagedHarnessRuntimeError(
    'runtime.input_invalid',
    'A complete DSH commit SHA is required.'
  )
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
