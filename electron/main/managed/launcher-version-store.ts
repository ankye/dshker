import { randomUUID } from 'node:crypto'
import { open, readFile, realpath, rename, rm } from 'node:fs/promises'
import nodePath from 'node:path'
import { GitRuntimeError, selectGitBranch } from './git'
import { launcherGitArguments } from './launcher-harness-commands'
import { readHarnessReadiness } from './launcher-harness-views'
import { assertDirectDirectory, assertDirectRegularFile, runText } from './process-utils'
import { ManagedHarnessRuntimeError } from './runtime-errors'

/** Identifies the active-version record owned by the Launcher. */
export const LAUNCHER_VERSION_POINTER_FORMAT = 'dsh-launcher-harness-current-in-place' as const
const LEGACY_VERSION_POINTER_FORMAT = 'dsh-launcher-harness-current'

/** The installation's main repository, or the original SHA naming its retained legacy worktree. */
type LauncherVersionCheckout = 'repository' | string

interface InPlaceVersionPointer {
  readonly status: 'preparing' | 'ready'
  readonly commit: string
  readonly checkout: LauncherVersionCheckout
  readonly branch: string | null
}

export type LauncherVersionPointer =
  | { readonly status: 'legacy'; readonly commit: string }
  | InPlaceVersionPointer

export interface LauncherVersionSelection {
  readonly commit: string
  /** The explicitly selected remote branch. Exact commit and tag selections use null. */
  readonly branch: string | null
  readonly reference: string
}

/** Build actions provided by the Launcher service. */
export interface VersionMaterializationSteps {
  readonly loggedStep: <T>(description: string, step: () => Promise<T>) => Promise<T>
  readonly install: (directory: string) => Promise<void>
  readonly build: (directory: string) => Promise<void>
  readonly reconcilePlugins: (directory: string) => Promise<void>
  readonly validate: (directory: string) => Promise<void>
  readonly event: (message: string) => void
}

/** Publishes the preparation or activation record through an atomic same-directory rename. */
export async function writeCurrentVersionPointer(
  pointerPath: string,
  pointer: LauncherVersionPointer
): Promise<void> {
  const record =
    pointer.status === 'legacy'
      ? { format: LEGACY_VERSION_POINTER_FORMAT, commit: pointer.commit }
      : { format: LAUNCHER_VERSION_POINTER_FORMAT, ...pointer }
  parseVersionPointer(record)
  const parent = nodePath.dirname(pointerPath)
  const stagingPath = nodePath.join(
    parent,
    `.${nodePath.basename(pointerPath)}.${randomUUID()}.tmp`
  )
  try {
    await assertDirectDirectory(parent)
    const file = await open(stagingPath, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(stagingPath, pointerPath)
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined)
    throw new ManagedHarnessRuntimeError(
      'runtime.version_pointer_invalid',
      'The Launcher could not persist the DSH version record.',
      { cause: error instanceof Error ? error.name : 'unknown' }
    )
  }
}

/** Reads the persisted selection. Absence means the first version has never been prepared. */
export async function readCurrentVersionPointer(
  pointerPath: string
): Promise<LauncherVersionPointer | undefined> {
  let text: string
  try {
    await assertDirectRegularFile(pointerPath)
    text = await readFile(pointerPath, 'utf8')
  } catch (error) {
    if (isNodeCode(error, 'ENOENT')) return undefined
    throw new ManagedHarnessRuntimeError(
      'runtime.version_pointer_invalid',
      'The Launcher could not read the DSH version record.'
    )
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw malformedPointer()
  }
  return parseVersionPointer(document)
}

function parseVersionPointer(value: unknown): LauncherVersionPointer {
  if (value === null || typeof value !== 'object') throw malformedPointer()
  const record = value as Record<string, unknown>
  if (!isCommit(record.commit)) throw malformedPointer()
  if (record.format === LEGACY_VERSION_POINTER_FORMAT && Object.keys(record).length === 2) {
    return { status: 'legacy', commit: record.commit }
  }
  if (
    record.format !== LAUNCHER_VERSION_POINTER_FORMAT ||
    Object.keys(record).length !== 5 ||
    (record.status !== 'preparing' && record.status !== 'ready') ||
    (record.checkout !== 'repository' && !isCommit(record.checkout)) ||
    (record.branch !== null && !isBranch(record.branch))
  ) {
    throw malformedPointer()
  }
  return {
    status: record.status,
    commit: record.commit,
    checkout: record.checkout,
    branch: record.branch
  }
}

/** Resolves a legacy worktree name without allowing arbitrary paths in a version record. */
export function versionDirectory(versionsDirectory: string, commit: string): string {
  if (!isCommit(commit)) throw malformedPointer()
  return nodePath.join(versionsDirectory, commit)
}

export function launcherVersionDirectory(
  mainRepository: string,
  versionsDirectory: string,
  pointer: LauncherVersionPointer
): string {
  const checkout = pointer.status === 'legacy' ? pointer.commit : pointer.checkout
  return checkout === 'repository' ? mainRepository : versionDirectory(versionsDirectory, checkout)
}

/** Verifies checkout ownership and the exact prepared commit before using built output. */
export async function assertLauncherVersionCheckout(
  gitExecutable: string,
  mainRepository: string,
  directory: string,
  expectedCommit: string
): Promise<void> {
  const head = await readVerifiedCheckoutHead(gitExecutable, mainRepository, directory)
  assertCheckoutCommit(head.commit, expectedCommit)
  if (!head.detached) {
    throw new ManagedHarnessRuntimeError(
      'runtime.worktree_invalid',
      'The prepared DSH version is no longer pinned to a detached Git HEAD.'
    )
  }
}

/** Prepares the selected revision in the installation's recorded checkout. */
export async function materializeLauncherVersion(
  gitExecutable: string,
  mainRepository: string,
  versionsDirectory: string,
  pointerPath: string,
  selection: LauncherVersionSelection,
  steps: VersionMaterializationSteps
): Promise<void> {
  const { commit, branch } = selection
  assertVersionSelection(selection)
  const current = await readCurrentVersionPointer(pointerPath)
  const preparation: InPlaceVersionPointer = {
    status: 'preparing',
    commit,
    checkout: current?.status === 'legacy' ? current.commit : (current?.checkout ?? 'repository'),
    branch
  }
  const directory = launcherVersionDirectory(mainRepository, versionsDirectory, preparation)
  const head = await steps.loggedStep(
    'Verifying the selected DSH commit and checking for local changes',
    async () => {
      const existingHead = await readVerifiedCheckoutHead(gitExecutable, mainRepository, directory)
      if (current !== undefined && current.status !== 'preparing') {
        assertCheckoutCommit(existingHead.commit, current.commit)
      }
      await assertEligibleCommit(gitExecutable, mainRepository, selection)
      await assertCheckoutClean(gitExecutable, directory)
      return existingHead
    }
  )

  const ready: InPlaceVersionPointer = { ...preparation, status: 'ready' }
  if (
    current !== undefined &&
    current.status !== 'preparing' &&
    head.commit === commit &&
    head.detached &&
    (await readHarnessReadiness(directory)).kind === 'ready'
  ) {
    steps.event(`DSH commit ${commit} is already prepared in the Launcher checkout.`)
    await steps.loggedStep('Checking DSH core and profile plugin compatibility', async () => {
      await steps.validate(directory)
      await assertLauncherVersionCheckout(gitExecutable, mainRepository, directory, commit)
      await writeCurrentVersionPointer(pointerPath, ready)
    })
    return
  }

  await steps.loggedStep(`Selecting DSH commit ${commit} in the existing checkout`, async () => {
    await writeCurrentVersionPointer(pointerPath, preparation)
    if (head.commit !== commit || !head.detached) {
      try {
        await runCheckoutGit(gitExecutable, directory, [
          'switch',
          '--detach',
          '--no-overwrite-ignore',
          commit
        ])
      } catch {
        throw new ManagedHarnessRuntimeError(
          'runtime.worktree_invalid',
          'Git could not switch the existing Launcher Harness checkout without overwriting files.'
        )
      }
      await assertCheckoutClean(gitExecutable, directory)
    }
    await assertLauncherVersionCheckout(gitExecutable, mainRepository, directory, commit)
  })
  await steps.loggedStep('Installing DSH dependencies (pnpm install --frozen-lockfile)', () =>
    steps.install(directory)
  )
  await steps.loggedStep('Building DSH (pnpm run build)', () => steps.build(directory))
  await steps.loggedStep('Reconciling the DSH web profile plugins', () =>
    steps.reconcilePlugins(directory)
  )
  await steps.loggedStep('Checking DSH core and profile plugin compatibility', async () => {
    const readiness = await readHarnessReadiness(directory)
    if (readiness.kind !== 'ready') {
      throw new ManagedHarnessRuntimeError('runtime.worktree_invalid', readiness.message)
    }
    await steps.validate(directory)
    await assertLauncherVersionCheckout(gitExecutable, mainRepository, directory, commit)
    await writeCurrentVersionPointer(pointerPath, ready)
  })
}

function assertVersionSelection(selection: LauncherVersionSelection): void {
  const { branch, commit, reference } = selection
  if (
    !isCommit(commit) ||
    (branch !== null && !isBranch(branch)) ||
    reference !== `refs/remotes/origin/${branch ?? 'master'}`
  ) {
    throw new ManagedHarnessRuntimeError(
      'runtime.input_invalid',
      'An exact DSH commit or origin branch selection is required.'
    )
  }
}

async function assertEligibleCommit(
  gitExecutable: string,
  repository: string,
  { commit, branch, reference }: LauncherVersionSelection
): Promise<void> {
  try {
    if (branch === null) {
      await runCheckoutGit(gitExecutable, repository, [
        'merge-base',
        '--is-ancestor',
        commit,
        reference
      ])
      return
    }
    const tip = (
      await runCheckoutGit(gitExecutable, repository, ['rev-parse', '--verify', reference])
    ).trim()
    if (tip === commit) return
  } catch {
    throw unavailableSelection()
  }
  throw unavailableSelection()
}

async function assertCheckoutClean(gitExecutable: string, directory: string): Promise<void> {
  let status: string
  try {
    status = await runCheckoutGit(gitExecutable, directory, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=none'
    ])
  } catch {
    throw invalidCheckout()
  }
  if (status.length !== 0) {
    throw new GitRuntimeError(
      'git.repository_dirty',
      'Resolve staged or unstaged changes to tracked files before switching the DSH version.'
    )
  }
}

async function readVerifiedCheckoutHead(
  gitExecutable: string,
  mainRepository: string,
  directory: string
): Promise<{ readonly commit: string; readonly detached: boolean }> {
  const mainGitDirectory = nodePath.join(mainRepository, '.git')
  const checkoutGitEntry = nodePath.join(directory, '.git')
  try {
    await Promise.all([
      assertDirectDirectory(mainGitDirectory),
      directory === mainRepository ? Promise.resolve() : assertDirectRegularFile(checkoutGitEntry)
    ])
    const [identity, topLevel, canonicalGit] = await Promise.all([
      runCheckoutGit(gitExecutable, directory, [
        'rev-parse',
        '--show-toplevel',
        '--git-common-dir',
        '--absolute-git-dir',
        'HEAD',
        '--abbrev-ref',
        'HEAD'
      ]),
      realpath(directory),
      realpath(mainGitDirectory)
    ])
    const [gitTopLevel, gitCommon, gitDirectory, head, headReference, ...extra] = identity
      .trimEnd()
      .split(/\r?\n/u)
    if (
      gitTopLevel === undefined ||
      gitCommon === undefined ||
      gitDirectory === undefined ||
      !isCommit(head) ||
      headReference === undefined ||
      extra.length > 0
    ) {
      throw invalidCheckout()
    }
    const commonDirectory = nodePath.resolve(directory, gitCommon)
    const gitDir = nodePath.normalize(gitDirectory)
    await Promise.all([assertDirectDirectory(commonDirectory), assertDirectDirectory(gitDir)])
    if (
      (await realpath(gitTopLevel)) !== topLevel ||
      (await realpath(commonDirectory)) !== canonicalGit
    ) {
      throw invalidCheckout()
    }
    const canonicalGitDir = await realpath(gitDir)
    if (directory === mainRepository) {
      if (canonicalGitDir !== canonicalGit) throw invalidCheckout()
    } else {
      const backlinkFile = nodePath.join(gitDir, 'gitdir')
      if (
        nodePath.dirname(canonicalGitDir) !==
        (await realpath(nodePath.join(mainGitDirectory, 'worktrees')))
      ) {
        throw invalidCheckout()
      }
      await assertDirectRegularFile(backlinkFile)
      const backlink = (await readFile(backlinkFile, 'utf8')).replace(/\r?\n$/u, '')
      if (
        (await realpath(nodePath.resolve(gitDir, backlink))) !== (await realpath(checkoutGitEntry))
      ) {
        throw invalidCheckout()
      }
    }
    return { commit: head, detached: headReference === 'HEAD' }
  } catch {
    throw invalidCheckout()
  }
}

function runCheckoutGit(
  executable: string,
  directory: string,
  arguments_: readonly string[]
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name))
  )
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return runText(
    executable,
    launcherGitArguments([
      '--no-pager',
      '-c',
      `core.hooksPath=${nullDevice}`,
      '-c',
      'core.fsmonitor=false',
      '-C',
      directory,
      ...arguments_
    ]),
    { env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }
  )
}

function assertCheckoutCommit(head: string, expectedCommit: string): void {
  if (head !== expectedCommit) {
    throw new ManagedHarnessRuntimeError(
      'runtime.worktree_invalid',
      'The Launcher Harness checkout HEAD does not match the prepared DSH version.'
    )
  }
}

function invalidCheckout(): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError(
    'runtime.worktree_invalid',
    'The Launcher Harness checkout could not be verified against its registered repository.'
  )
}

function unavailableSelection(): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError(
    'runtime.input_invalid',
    'The selected DSH revision is unavailable on its observed origin reference.'
  )
}

function malformedPointer(): ManagedHarnessRuntimeError {
  return new ManagedHarnessRuntimeError(
    'runtime.version_pointer_invalid',
    'The active DSH version record is malformed.'
  )
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
}

function isBranch(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    selectGitBranch(value)
    return true
  } catch {
    return false
  }
}

function isNodeCode(value: unknown, expected: string): boolean {
  return Boolean(value && typeof value === 'object' && 'code' in value && value.code === expected)
}
